// Text handling for the open-model engines (pure, so AgentCoreChecks covers it).
//   Whisper: settings language id -> Whisper language code; strip special tokens from output.
//   Qwen (llama.cpp): ChatML prompt in, JSON out -> MeetingSummary / notes.
import Foundation

public enum OpenModelText {
    /// "hi_IN" -> "hi", "auto"/nil -> nil (Whisper detects the language itself).
    public static func whisperLanguage(_ localeId: String?) -> String? {
        guard let id = localeId, id != "auto", let code = id.split(separator: "_").first, (2...3).contains(code.count) else { return nil }
        return String(code)
    }

    /// Whisper output can carry tokens like "<|0.00|>" or "<|en|>": remove them and tidy spaces.
    public static func cleanWhisper(_ text: String) -> String {
        text.replacingOccurrences(of: #"<\|[^|>]*\|>"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Qwen3 chat prompt with thinking turned off (shorter, faster, same quality for summaries).
    public static func chatPrompt(system: String, user: String) -> String {
        "<|im_start|>system\n\(system)<|im_end|>\n<|im_start|>user\n\(user) /no_think<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    }

    /// JSON schema the model's output is constrained to (llama.cpp turns it into a grammar).
    public static let summarySchema = #"{"type":"object","properties":{"overview":{"type":"string"},"keyPoints":{"type":"array","items":{"type":"string"},"maxItems":7},"decisions":{"type":"array","items":{"type":"string"},"maxItems":7},"actionItems":{"type":"array","items":{"type":"string"},"maxItems":10}},"required":["overview","keyPoints","decisions","actionItems"]}"#
    public static let notesSchema = #"{"type":"object","properties":{"points":{"type":"array","items":{"type":"string"},"maxItems":12}},"required":["points"]}"#

    public static func parseSummary(_ output: String) -> MeetingSummary? {
        guard let object = jsonObject(output), let overview = object["overview"] as? String else { return nil }
        let list = { (key: String) in (object[key] as? [Any] ?? []).compactMap { $0 as? String } }
        return MeetingSummary(overview: overview, keyPoints: list("keyPoints"), decisions: list("decisions"), actionItems: list("actionItems"))
    }

    public static func parseNotes(_ output: String) -> String? {
        guard let points = jsonObject(output)?["points"] as? [Any] else { return nil }
        return points.compactMap { $0 as? String }.map { "- \($0)" }.joined(separator: "\n")
    }

    /// The first {...} in the output (llama.cpp may append "[end of text]").
    static func jsonObject(_ output: String) -> [String: Any]? {
        guard let start = output.firstIndex(of: "{"), let end = output.lastIndex(of: "}"), start < end else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(output[start...end].utf8))) as? [String: Any]
    }
}
