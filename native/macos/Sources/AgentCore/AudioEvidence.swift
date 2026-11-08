// Acoustic checks on transcript lines, independent of language and spelling.
//
// Echo: without headphones the mic also hears the call through the speakers, so the other side's
// words come back as "You" lines. Comparing the words fails when the two copies are spelled or
// scripted differently ("रुपे" vs "रुपय", "phone" vs "फोन"). So we compare the SOUND: loudness
// envelopes (10 ms frames, in dB) of the mic and the call audio over the line's time, allowing
// for the speaker-to-mic delay. An echo rises and falls with the call audio (high correlation);
// your own voice doesn't. Otter does a similar mic/system correlation in its audio worklet.
//
// Silence: speech models invent text from silence ("Thank you."). A line whose own track is near
// silent for its whole time is dropped, and so is a "line" with fewer than two letters (a single
// Chinese, Japanese or Korean character is a word and is kept).
import Foundation

public enum AudioEvidence {
    /// Envelope frames per second (10 ms frames).
    public static let framesPerSecond = 100
    /// Max speaker-to-mic delay considered, in frames (300 ms).
    public static let maxLagFrames = 30
    /// Correlation at or above this means the line is an echo of the call audio.
    public static let echoCorrelation = 0.6
    /// A line whose track never gets louder than this (dBFS) is silence.
    public static let silenceDb = -50.0

    /// Loudness envelope: RMS in dBFS of each 10 ms frame of mono samples at `sampleRate`.
    public static func envelope(_ samples: [Float], sampleRate: Double) -> [Double] {
        let frame = max(1, Int(sampleRate) / framesPerSecond)
        return stride(from: 0, to: samples.count, by: frame).map { start in
            let end = min(samples.count, start + frame)
            var sum: Float = 0
            for i in start..<end { sum += samples[i] * samples[i] }
            let rms = sqrt(Double(sum) / Double(end - start))
            return rms > 0 ? max(-100, 20 * log10(rms)) : -100
        }
    }

    /// Highest Pearson correlation between `mic` and `system` envelope windows for lags 0...maxLag
    /// (the mic hears the speakers late, never early). 0 when a window is too short or flat.
    public static func echoScore(mic: ArraySlice<Double>, system: [Double], micStart: Int, maxLag: Int = maxLagFrames) -> Double {
        guard mic.count >= 20 else { return 0 } // under 200 ms: too little to judge
        var best = 0.0
        for lag in 0...maxLag {
            let systemStart = micStart - lag
            guard systemStart >= 0, systemStart + mic.count <= system.count else { continue }
            best = max(best, pearson(Array(mic), Array(system[systemStart..<(systemStart + mic.count)])))
        }
        return best
    }

    /// True when the envelope never rises above the silence level.
    public static func isSilent(_ window: ArraySlice<Double>) -> Bool {
        (window.max() ?? -100) < silenceDb
    }

    /// Writes a buffer's envelope frames at its exact place on the timeline (seconds × 100), padding
    /// any gap with silence. Not appended: a buffer's partial last frame is overwritten by the next
    /// buffer, so the envelope never drifts ahead of real time over a long meeting.
    public static func write(_ frames: [Double], at seconds: Double, into envelope: inout [Double]) {
        let start = Int((seconds * Double(framesPerSecond)).rounded())
        guard start >= 0 else { return }
        let end = start + frames.count
        if envelope.count < end { envelope += Array(repeating: -100, count: end - envelope.count) }
        envelope.replaceSubrange(start..<end, with: frames)
    }

    /// At least two letters or digits, or one CJK / kana / hangul character (a whole word there).
    static func isSpeechText(_ text: String) -> Bool {
        let letters = text.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }
        if letters.count >= 2 { return true }
        guard let only = letters.first?.value else { return false }
        return (0x3040...0x30FF).contains(only) || (0x3400...0x9FFF).contains(only) || (0xAC00...0xD7AF).contains(only)
    }

    static func pearson(_ a: [Double], _ b: [Double]) -> Double {
        let n = Double(a.count)
        let ma = a.reduce(0, +) / n, mb = b.reduce(0, +) / n
        var num = 0.0, da = 0.0, db = 0.0
        for i in 0..<a.count {
            let x = a[i] - ma, y = b[i] - mb
            num += x * y; da += x * x; db += y * y
        }
        let den = (da * db).squareRoot()
        return den > 1e-9 ? num / den : 0
    }

    /// Keeps the lines that are real speech: drops "You" lines that echo the call audio, and any
    /// line whose own track is silent for its whole time. Envelopes are indexed by frame.
    public static func filter(_ segments: [Transcript.Segment], mic: [Double]?, system: [Double]?) -> [Transcript.Segment] {
        segments.filter { segment in
            // Fragments like "अ" or "-" are noise, not speech (a single CJK character is a word: kept).
            guard isSpeechText(segment.text) else { return false }
            let track = segment.speaker == "You" ? mic : system
            let from = max(0, Int(segment.start * Double(framesPerSecond)))
            let to = Int(segment.end * Double(framesPerSecond))
            if let track, from < to, to <= track.count, isSilent(track[from..<to]) { return false }
            if segment.speaker == "You", let mic, let system, from < to, to <= mic.count {
                return echoScore(mic: mic[from..<to], system: system, micStart: from) < echoCorrelation
            }
            return true
        }
    }
}
