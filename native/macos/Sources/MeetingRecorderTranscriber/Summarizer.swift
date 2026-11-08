// Meeting summaries, made on this Mac. Two engines share the same map-reduce:
//   apple  Apple's on-device model (Foundation Models, macOS 26 + Apple Intelligence), ~4k-token window
//   qwen   Qwen3 1.7B via llama.cpp (QwenSummaryModel), ~6k-token window, any Apple-silicon Mac (8 GB+)
//
//   transcript.json ─▶ lines "Speaker: text" ─▶ fits the model's window?
//        yes ─▶ one structured request (overview, key points, decisions, action items)
//        no  ─▶ map: notes per chunk ─▶ reduce: notes of notes until they fit ─▶ summary
//   ─▶ summary.json + summary.md (atomic)
//
// The Apple engine uses DynamicGenerationSchema (runtime schema) rather than @Generable: the macro
// plugin ships only with full Xcode, and this builds with just the Command Line Tools.
import AgentCore
import Foundation
import FoundationModels

/// What a summary engine must do. Each call gets a fresh context.
protocol SummaryModel {
    var maxChunkTokens: Int { get }
    func summarize(_ content: String, what: String) async throws -> MeetingSummary
    func notes(_ chunk: String, part: Int, of total: Int) async throws -> String
}

let summaryInstructions = """
You summarize meeting transcripts accurately and concisely. Use only facts stated in the \
transcript; never invent names, numbers or dates. "You" is the person who recorded the meeting; \
"Others" are the other participants. Action items start with the owner when mentioned \
(e.g. "Priya: send the deck").
"""

enum Summarizer {
    static func run(directory: URL, model: SummaryModel) async throws {
        let data = try Data(contentsOf: directory.appendingPathComponent("transcript.json"))
        let transcript = try JSONDecoder().decode(AgentCore.Transcript.self, from: data) // FoundationModels has its own Transcript
        let title = (try? JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("meta.json"))) as? [String: Any])?["title"] as? String ?? "Meeting"

        let lines = TranscriptChunker.lines(transcript)
        guard !lines.isEmpty else { return try MeetingSummary.noSpeech.write(to: directory, title: title) }

        let chunks = TranscriptChunker.chunks(lines, maxTokens: model.maxChunkTokens)
        let summary: MeetingSummary
        if chunks.count == 1 {
            summary = try await model.summarize(chunks[0], what: "this meeting transcript")
        } else {
            // Map: condense each part into notes, then reduce the notes (repeatedly if needed).
            var notes = chunks
            while notes.count > 1 { // each round shrinks the text: notes are much shorter than talk
                var condensed: [String] = []
                for (i, chunk) in notes.enumerated() {
                    emit(["percent": min(90, (i * 90) / max(1, notes.count)), "stage": "summarizing part \(i + 1) of \(notes.count)"])
                    condensed.append(try await model.notes(chunk, part: i + 1, of: notes.count))
                }
                let next = TranscriptChunker.chunks(condensed, maxTokens: model.maxChunkTokens)
                // No progress means it would never fit: say so rather than summarize only part of it.
                if next.count >= notes.count { fail(6, "This meeting is too long to summarize on this Mac.") }
                notes = next
            }
            summary = try await model.summarize(notes[0], what: "these notes from one long meeting")
        }
        try summary.write(to: directory, title: title)
    }
}

/// Apple's on-device model (Foundation Models).
@available(macOS 26.0, *)
struct AppleSummaryModel: SummaryModel {
    let maxChunkTokens = TranscriptChunker.maxChunkTokens

    /// Exits with the right code when the model can't run here.
    static func checkAvailable() {
        switch SystemLanguageModel.default.availability {
        case .available: break
        case .unavailable(.modelNotReady): fail(5, "Apple's on-device model is still getting ready. Summaries will start when it's done.")
        case .unavailable(.appleIntelligenceNotEnabled): fail(3, "Summaries need Apple Intelligence turned on (System Settings > Apple Intelligence & Siri).")
        case .unavailable: fail(3, "This Mac can't run Apple's on-device model, so summaries aren't available.")
        }
    }

    private static let text = DynamicGenerationSchema(type: String.self)
    private static func list(_ max: Int) -> DynamicGenerationSchema { DynamicGenerationSchema(arrayOf: text, maximumElements: max) }

    func summarize(_ content: String, what: String) async throws -> MeetingSummary {
        let root = DynamicGenerationSchema(name: "MeetingSummary", properties: [
            .init(name: "overview", description: "Two or three sentences: what the meeting was about and its outcome.", schema: Self.text),
            .init(name: "keyPoints", description: "The most important points, one short sentence each.", schema: Self.list(7)),
            .init(name: "decisions", description: "Decisions that were made. Empty if none.", schema: Self.list(7)),
            .init(name: "actionItems", description: "Action items, starting with the owner if mentioned (e.g. 'Priya: send the deck'). Empty if none.", schema: Self.list(10)),
        ])
        let response = try await Self.respond(to: "Summarize \(what):\n\n\(content)", schema: GenerationSchema(root: root, dependencies: []))
        let c = response.content
        return MeetingSummary(
            overview: try c.value(String.self, forProperty: "overview"),
            keyPoints: try c.value([String].self, forProperty: "keyPoints"),
            decisions: try c.value([String].self, forProperty: "decisions"),
            actionItems: try c.value([String].self, forProperty: "actionItems"))
    }

    func notes(_ chunk: String, part: Int, of total: Int) async throws -> String {
        let root = DynamicGenerationSchema(name: "Notes", properties: [
            .init(name: "points", description: "Everything important in this part: topics, facts, decisions and action items with owners. One short sentence each.", schema: Self.list(12)),
        ])
        let response = try await Self.respond(to: "This is part \(part) of \(total) of a meeting transcript. Write notes on it:\n\n\(chunk)",
                                          schema: GenerationSchema(root: root, dependencies: []))
        return try response.content.value([String].self, forProperty: "points").map { "- \($0)" }.joined(separator: "\n")
    }

    /// A fresh session per request: each part gets the whole context window.
    private static func respond(to prompt: String, schema: GenerationSchema) async throws -> LanguageModelSession.Response<GeneratedContent> {
        do {
            return try await LanguageModelSession(instructions: summaryInstructions).respond(to: prompt, schema: schema)
        } catch let error as LanguageModelSession.GenerationError {
            switch error {
            case .guardrailViolation: fail(6, "Apple's on-device model declined to summarize this meeting.")
            case .exceededContextWindowSize: fail(6, "A part of this meeting was too long to summarize.")
            default: throw error
            }
        }
    }
}

/// Qwen3 1.7B through llama.cpp's one-shot CLI. Light by design: a 6k-token window with an 8-bit
/// KV cache, at most 4 CPU threads, the model memory-mapped (reclaimable), output constrained to
/// the JSON schema. The daemon already runs this whole process at background priority.
struct QwenSummaryModel: SummaryModel {
    let binary: URL
    let model: URL
    // Our estimate can undercount Qwen's tokens (by ~30% for some scripts), so chunks are kept at
    // 3k estimated: ~3.9k real + instructions + up to 1k generated tokens stays inside 6k.
    let maxChunkTokens = 3_000

    func summarize(_ content: String, what: String) async throws -> MeetingSummary {
        let output = try generate("Summarize \(what):\n\n\(content)", schema: OpenModelText.summarySchema)
        guard let summary = OpenModelText.parseSummary(output) else { throw ModelError("The open model's summary couldn't be read.") }
        return summary
    }

    func notes(_ chunk: String, part: Int, of total: Int) async throws -> String {
        let output = try generate("This is part \(part) of \(total) of a meeting transcript. List everything important in it: topics, facts, decisions and action items with owners, one short sentence each.\n\n\(chunk)",
                                  schema: OpenModelText.notesSchema)
        guard let notes = OpenModelText.parseNotes(output) else { throw ModelError("The open model's notes couldn't be read.") }
        return notes
    }

    private func generate(_ prompt: String, schema: String) throws -> String {
        let promptFile = FileManager.default.temporaryDirectory.appendingPathComponent("mr-prompt-\(UUID().uuidString).txt")
        try Data(OpenModelText.chatPrompt(system: summaryInstructions, user: prompt).utf8).write(to: promptFile)
        defer { try? FileManager.default.removeItem(at: promptFile) }
        let threads = max(2, min(4, ProcessInfo.processInfo.activeProcessorCount / 2))
        let data = try OpenModels.run(binary.path, [
            "-m", model.path, "-f", promptFile.path, "-c", "6144", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0",
            "-n", "1024", "--temp", "0.2", "-t", String(threads), "--json-schema", schema, "-no-cnv", "--no-display-prompt",
        ])
        return String(decoding: data, as: UTF8.self)
    }
}
