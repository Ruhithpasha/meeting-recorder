// Meeting summary model and formats (pure, so AgentCoreChecks covers it).
//   summary.json  {"version":1,"overview","keyPoints":[],"decisions":[],"actionItems":[]}
//   summary.md    the same, as Markdown, next to the recording
import Foundation

public struct MeetingSummary: Codable, Equatable, Sendable {
    public let version: Int
    public let overview: String
    public let keyPoints: [String]
    public let decisions: [String]
    public let actionItems: [String]

    public init(overview: String, keyPoints: [String], decisions: [String], actionItems: [String]) {
        self.version = 1
        let clean = { (items: [String]) in items.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
        self.overview = overview.trimmingCharacters(in: .whitespacesAndNewlines)
        self.keyPoints = clean(keyPoints)
        self.decisions = clean(decisions)
        self.actionItems = clean(actionItems)
    }

    public static let noSpeech = MeetingSummary(overview: "No speech was found in this recording.", keyPoints: [], decisions: [], actionItems: [])

    public func markdown(title: String) -> String {
        var md = "# \(title)\n\n\(overview)\n"
        for (heading, items) in [("Key points", keyPoints), ("Decisions", decisions), ("Action items", actionItems)] where !items.isEmpty {
            md += "\n## \(heading)\n\n" + items.map { "- \($0)" }.joined(separator: "\n") + "\n"
        }
        return md + "\n_Summarized on this Mac by Apple's on-device model. Check important details against the recording._\n"
    }

    public func write(to directory: URL, title: String) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try FileWriting.atomic(encoder.encode(self), to: directory.appendingPathComponent("summary.json"))
        try FileWriting.atomic(Data(markdown(title: title).utf8), to: directory.appendingPathComponent("summary.md"))
    }
}

/// Splits a transcript into chunks that fit the on-device model's small context window
/// (~4k tokens incl. instructions and output). Lines are never split; a single huge line is cut.
/// Sizes are estimated in tokens, not characters: Latin text is ~4 characters per token, but
/// Chinese, Japanese, Hindi and similar scripts are about one token per character or more.
public enum TranscriptChunker {
    /// Token budget per chunk; leaves room for instructions, schema and the generated summary.
    public static let maxChunkTokens = 2_000

    public static func estimatedTokens(_ text: String) -> Int {
        var ascii = 0, other = 0
        for scalar in text.unicodeScalars { if scalar.isASCII { ascii += 1 } else { other += 1 } }
        return (ascii + 3) / 4 + other
    }

    public static func lines(_ transcript: Transcript) -> [String] {
        transcript.segments.map { "\($0.speaker): \($0.text)" }
    }

    public static func chunks(_ lines: [String], maxTokens: Int = maxChunkTokens) -> [String] {
        var chunks: [String] = []
        var current = "", currentTokens = 0
        for raw in lines {
            var line = raw
            while estimatedTokens(line) > maxTokens { line = String(line.prefix(line.count * 3 / 4)) } // huge line: cut
            let tokens = estimatedTokens(line) + 1
            if !current.isEmpty, currentTokens + tokens > maxTokens {
                chunks.append(current)
                current = ""
                currentTokens = 0
            }
            current += current.isEmpty ? line : "\n" + line
            currentTokens += tokens
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }
}

public enum FileWriting {
    /// Temp file + replace: a killed process never leaves a half-written file.
    public static func atomic(_ data: Data, to url: URL) throws {
        let tmp = url.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).tmp")
        try data.write(to: tmp)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: tmp)
    }
}
