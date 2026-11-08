// Transcript model and file formats (pure, so AgentCoreChecks covers it).
//   transcript.json  {"version":1,"language":"en_US","durationSec":…,"segments":[{"start","end","speaker","text"}]}
//   transcript.vtt   WebVTT with <v Speaker> voice tags, for any video player
import Foundation

public struct Transcript: Codable, Equatable, Sendable {
    public struct Segment: Codable, Equatable, Sendable {
        public let start: Double
        public let end: Double
        public let speaker: String
        public let text: String
        public init(start: Double, end: Double, speaker: String, text: String) {
            self.start = start
            self.end = end
            self.speaker = speaker
            self.text = text
        }
    }

    public let version: Int
    public let language: String
    public let durationSec: Double
    public let segments: [Segment]

    /// Segments from every track merged into one timeline.
    public init(language: String, durationSec: Double, segments: [Segment]) {
        self.version = 1
        self.language = language
        self.durationSec = durationSec
        self.segments = segments.sorted { ($0.start, $0.speaker) < ($1.start, $1.speaker) }
    }

    /// Recordings have the system audio track first (the other participants), then the mic (you).
    public static func speakerLabels(trackCount: Int) -> [String] {
        switch trackCount {
        case 1: return ["Speaker"]
        case 2: return ["Others", "You"]
        default: return (1...max(1, trackCount)).map { "Track \($0)" }
        }
    }

    public func vtt() -> String {
        var out = "WEBVTT\n"
        for (i, s) in segments.enumerated() {
            let speaker = s.speaker.replacingOccurrences(of: ">", with: "")
            let text = s.text.replacingOccurrences(of: "-->", with: "->").replacingOccurrences(of: "\n", with: " ")
            out += "\n\(i + 1)\n\(Self.timestamp(s.start)) --> \(Self.timestamp(max(s.end, s.start))) \n<v \(speaker)>\(text)\n"
        }
        return out
    }

    public static func timestamp(_ seconds: Double) -> String {
        let ms = Int((max(0, seconds) * 1000).rounded())
        return String(format: "%02d:%02d:%02d.%03d", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
    }

    /// Atomic writes (temp + rename): a killed transcriber never leaves a half-written transcript.
    public func write(to directory: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try FileWriting.atomic(encoder.encode(self), to: directory.appendingPathComponent("transcript.json"))
        try FileWriting.atomic(Data(vtt().utf8), to: directory.appendingPathComponent("transcript.vtt"))
    }
}
