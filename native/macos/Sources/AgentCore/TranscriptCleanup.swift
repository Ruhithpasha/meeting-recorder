// Transcript clean-up (pure, so AgentCoreChecks covers it).
//
//  1. Echo removal. Without headphones, your mic also hears the other participants through the
//     speakers, so their words appear twice: once on "Others" (system audio) and again on "You".
//     A "You" line that overlaps an "Others" line in time and repeats a run of their words in the
//     same order (at least 3 words and 60% of the line) is their echo and is dropped. Requiring
//     an in-order run keeps real replies made of common words ("yes we can") that merely share
//     vocabulary with a long "Others" line.
//  2. Fragment merging. Consecutive lines from the same speaker with a short pause between them
//     become one readable line.
import Foundation

public enum TranscriptCleanup {
    public static let echoTimeSlack = 1.5        // seconds of timing difference tolerated
    public static let echoSimilarity = 0.6       // share of the "You" line repeated in order on "Others"
    public static let echoMinWords = 3
    public static let mergeGap = 1.2             // seconds
    public static let mergeMaxCharacters = 400

    public static func clean(_ segments: [Transcript.Segment]) -> [Transcript.Segment] {
        merge(removeEcho(segments))
    }

    public static func removeEcho(_ segments: [Transcript.Segment]) -> [Transcript.Segment] {
        let others = segments.filter { $0.speaker == "Others" }
        guard !others.isEmpty else { return segments }
        return segments.filter { segment in
            guard segment.speaker == "You" else { return true }
            let mine = words(segment.text)
            guard mine.count >= echoMinWords else { return true } // too short to tell echo from a reply
            let needed = max(echoMinWords, Int((Double(mine.count) * echoSimilarity).rounded(.up)))
            return !others.contains { other in
                other.start - echoTimeSlack <= segment.end && segment.start <= other.end + echoTimeSlack
                    && longestCommonRun(mine, words(other.text)) >= needed
            }
        }
    }

    /// Length of the longest run of consecutive words that appears in both lines.
    static func longestCommonRun(_ a: [String], _ b: [String]) -> Int {
        var best = 0
        var previous = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            var current = [Int](repeating: 0, count: b.count + 1)
            for j in stride(from: 1, through: b.count, by: 1) where a[i - 1] == b[j - 1] {
                current[j] = previous[j - 1] + 1
                best = max(best, current[j])
            }
            previous = current
        }
        return best
    }

    public static func merge(_ segments: [Transcript.Segment]) -> [Transcript.Segment] {
        var out: [Transcript.Segment] = []
        for segment in segments.sorted(by: { $0.start < $1.start }) {
            if let last = out.last, last.speaker == segment.speaker, segment.start - last.end <= mergeGap,
               last.text.count + segment.text.count + 1 <= mergeMaxCharacters {
                out[out.count - 1] = .init(start: last.start, end: max(last.end, segment.end), speaker: last.speaker, text: "\(last.text) \(segment.text)")
            } else {
                out.append(segment)
            }
        }
        return out
    }

    static func words(_ text: String) -> [String] {
        text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }
}
