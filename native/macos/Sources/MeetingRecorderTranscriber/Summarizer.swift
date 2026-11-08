// Meeting summaries with Apple's on-device language model (Foundation Models, macOS 26 +
// Apple Intelligence). Nothing leaves the Mac.
//
//   transcript.json ─▶ lines "Speaker: text" ─▶ fits the ~4k-token window?
//        yes ─▶ one structured request (overview, key points, decisions, action items)
//        no  ─▶ map: notes per chunk (fresh session each) ─▶ reduce: summary of the notes
//   ─▶ summary.json + summary.md (atomic)
//
// Uses DynamicGenerationSchema (runtime schema) rather than @Generable: the macro plugin ships
// only with full Xcode, and this builds with just the Command Line Tools.
import AgentCore
import Foundation
import FoundationModels

@available(macOS 26.0, *)
enum Summarizer {
    static let instructions = """
    You summarize meeting transcripts accurately and concisely. Use only facts stated in the \
    transcript; never invent names, numbers or dates. "You" is the person who recorded the meeting; \
    "Others" are the other participants.
    """

    static func run(directory: URL) async throws {
        switch SystemLanguageModel.default.availability {
        case .available: break
        case .unavailable(.modelNotReady): fail(5, "Apple's on-device model is still getting ready. Summaries will start when it's done.")
        case .unavailable(.appleIntelligenceNotEnabled): fail(3, "Summaries need Apple Intelligence turned on (System Settings > Apple Intelligence & Siri).")
        case .unavailable: fail(3, "This Mac can't run Apple's on-device model, so summaries aren't available.")
        }
        let data = try Data(contentsOf: directory.appendingPathComponent("transcript.json"))
        let transcript = try JSONDecoder().decode(AgentCore.Transcript.self, from: data) // FoundationModels has its own Transcript
        let title = (try? JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("meta.json"))) as? [String: Any])?["title"] as? String ?? "Meeting"

        let lines = TranscriptChunker.lines(transcript)
        guard !lines.isEmpty else { return try MeetingSummary.noSpeech.write(to: directory, title: title) }

        let chunks = TranscriptChunker.chunks(lines)
        let summary: MeetingSummary
        if chunks.count == 1 {
            summary = try await summarize(chunks[0], what: "this meeting transcript")
        } else {
            // Map: condense each part into notes, then reduce the notes (repeatedly if needed).
            var notes = chunks
            while notes.count > 1 { // each round shrinks the text: notes are much shorter than talk
                var condensed: [String] = []
                for (i, chunk) in notes.enumerated() {
                    emit(["percent": min(90, (i * 90) / max(1, notes.count)), "stage": "summarizing part \(i + 1) of \(notes.count)"])
                    condensed.append(try await notesFor(chunk, part: i + 1, of: notes.count))
                }
                let next = TranscriptChunker.chunks(condensed)
                // No progress means it would never fit: say so rather than summarize only part of it.
                if next.count >= notes.count { fail(6, "This meeting is too long to summarize on this Mac.") }
                notes = next
            }
            summary = try await summarize(notes[0], what: "these notes from one long meeting")
        }
        try summary.write(to: directory, title: title)
    }

    private static let text = DynamicGenerationSchema(type: String.self)
    private static func list(_ max: Int) -> DynamicGenerationSchema { DynamicGenerationSchema(arrayOf: text, maximumElements: max) }

    private static func summarize(_ content: String, what: String) async throws -> MeetingSummary {
        let root = DynamicGenerationSchema(name: "MeetingSummary", properties: [
            .init(name: "overview", description: "Two or three sentences: what the meeting was about and its outcome.", schema: text),
            .init(name: "keyPoints", description: "The most important points, one short sentence each.", schema: list(7)),
            .init(name: "decisions", description: "Decisions that were made. Empty if none.", schema: list(7)),
            .init(name: "actionItems", description: "Action items, starting with the owner if mentioned (e.g. 'Priya: send the deck'). Empty if none.", schema: list(10)),
        ])
        let response = try await respond(to: "Summarize \(what):\n\n\(content)", schema: GenerationSchema(root: root, dependencies: []))
        let c = response.content
        return MeetingSummary(
            overview: try c.value(String.self, forProperty: "overview"),
            keyPoints: try c.value([String].self, forProperty: "keyPoints"),
            decisions: try c.value([String].self, forProperty: "decisions"),
            actionItems: try c.value([String].self, forProperty: "actionItems"))
    }

    private static func notesFor(_ chunk: String, part: Int, of total: Int) async throws -> String {
        let root = DynamicGenerationSchema(name: "Notes", properties: [
            .init(name: "points", description: "Everything important in this part: topics, facts, decisions and action items with owners. One short sentence each.", schema: list(12)),
        ])
        let response = try await respond(to: "This is part \(part) of \(total) of a meeting transcript. Write notes on it:\n\n\(chunk)",
                                          schema: GenerationSchema(root: root, dependencies: []))
        return try response.content.value([String].self, forProperty: "points").map { "- \($0)" }.joined(separator: "\n")
    }

    /// A fresh session per request: each part gets the whole context window.
    private static func respond(to prompt: String, schema: GenerationSchema) async throws -> LanguageModelSession.Response<GeneratedContent> {
        do {
            return try await LanguageModelSession(instructions: instructions).respond(to: prompt, schema: schema)
        } catch let error as LanguageModelSession.GenerationError {
            switch error {
            case .guardrailViolation: fail(6, "Apple's on-device model declined to summarize this meeting.")
            case .exceededContextWindowSize: fail(6, "A part of this meeting was too long to summarize.")
            default: throw error
            }
        }
    }
}
