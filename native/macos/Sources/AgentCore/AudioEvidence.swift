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
            best = max(best, pearson(mic, system[systemStart..<(systemStart + mic.count)]))
        }
        return best
    }

    /// True when the envelope never rises above the silence level.
    public static func isSilent(_ window: ArraySlice<Double>) -> Bool {
        (window.max() ?? -100) < silenceDb
    }

    // MARK: Echo cancellation and levels, before speech recognition

    /// System audio quieter than this (dBFS) is "the call isn't speaking": no echo possible.
    public static let callActiveDb = -45.0
    /// Sliding window for the per-moment echo decision (300 ms).
    public static let echoWindowFrames = 30
    /// Gaps in the echo shorter than this (150 ms) are bridged, so the echo isn't left in pieces.
    public static let bridgeFrames = 15

    /// Below this whole-meeting correlation there's no echo to cancel (headphones): nothing is masked,
    /// so chance matches while you talk over someone can't silence your words.
    public static let meetingEchoCorrelation = 0.4

    /// The speaker-to-mic delay (frames, 0...maxLag) where the mic best follows the call audio, and
    /// how well (correlation). Only frames where the call speaks count: silences and gaps would
    /// otherwise decide the lag.
    public static func bulkDelay(mic: [Double], system: [Double], maxLag: Int = maxLagFrames) -> (delay: Int, score: Double) {
        let active = system.indices.filter { system[$0] > callActiveDb && $0 + maxLag < mic.count }
        guard active.count >= 50 else { return (0, 0) }
        var best = (delay: 0, score: -2.0)
        for lag in 0...maxLag {
            let score = pearson(active.lazy.map { mic[$0 + lag] }, active.lazy.map { system[$0] })
            if score > best.score { best = (lag, score) }
        }
        return best
    }

    /// Per envelope frame of the mic: true where it is only an echo of the call.
    ///   1. the call is speaking somewhere in the surrounding 300 ms (so the gaps between the
    ///      call's syllables don't break the echo into pieces), and the mic's loudness follows the
    ///      call's there (correlation ≥ 0.6);
    ///   2. and the mic isn't clearly louder than the echo usually is (learned from step 1): when you
    ///      talk over someone, your voice makes the mic louder than their echo, so it's kept.
    public static func echoMask(mic: [Double], system: [Double], delay: Int) -> [Bool] {
        let half = echoWindowFrames / 2
        let n = mic.count
        var candidate = [Bool](repeating: false, count: n)
        for i in 0..<n {
            let from = max(delay, i - half), to = min(n, system.count + delay, i + half)
            guard to - from >= 20 else { continue }
            guard system[(from - delay)..<(to - delay)].contains(where: { $0 > callActiveDb }) else { continue }
            if pearson(mic[from..<to], system[(from - delay)..<(to - delay)]) >= echoCorrelation { candidate[i] = true }
        }
        // The room's noise floor (10th percentile, ignoring digital-silence padding): an echo is
        // never quieter than the room.
        let floor = noiseFloor(mic)
        // How much quieter the echo is than the call: median over candidate frames where the call
        // speaks and the echo is clearly above the room (echo buried in noise would bias it up).
        let offsets = (0..<n).compactMap { i -> Double? in
            guard candidate[i], i - delay >= 0, i - delay < system.count, system[i - delay] > callActiveDb, mic[i] > floor + 6 else { return nil }
            return mic[i] - system[i - delay]
        }.sorted()
        guard !offsets.isEmpty else { return candidate }
        let echoOffset = offsets[offsets.count / 2]
        // Louder than its echo would be: someone's speaking here.
        func louder(_ i: Int) -> Bool {
            let call = (i - delay >= 0 && i - delay < system.count) ? system[i - delay] : -100
            return mic[i] > max(call + echoOffset, floor) + 6
        }
        let mask = (0..<n).map { candidate[$0] && !louder($0) }
        // Bridge gaps under 150 ms (a dip in correlation, not a word of yours: a word lasts longer)
        // but never over frames where the mic is louder than its echo.
        var bridged = mask
        var last = -1
        for i in 0..<n where mask[i] {
            if last >= 0, i - last > 1, i - last <= bridgeFrames, !((last + 1)..<i).contains(where: louder) {
                for k in (last + 1)..<i { bridged[k] = true }
            }
            last = i
        }
        return bridged
    }

    /// Most a track is raised: ×4. More lifts the background noise enough for invented words.
    public static let maxGainDb = 12.0

    /// Room noise is never raised above this (dBFS): lifted noise is where Whisper invents words.
    public static let maxNoiseDb = -55.0

    /// The room's noise level: 10th percentile of the envelope, ignoring digital-silence padding.
    public static func noiseFloor(_ envelope: [Double]) -> Double {
        let room = envelope.filter { $0 > -90 }.sorted()
        return room.isEmpty ? -90 : room[room.count / 10]
    }

    /// Gain that brings the speech (frames not masked and not silent) to -20 dBFS RMS, between ×1
    /// and ×4 (+12 dB), never so high that the loudest SAMPLE heard (`samplePeak`, linear) would
    /// clip or that the room noise would rise above maxNoiseDb.
    public static func normalizingGain(envelope: [Double], mask: [Bool] = [], samplePeak: Float = 0, targetDb: Double = -20) -> Float {
        let speech = envelope.indices.filter { envelope[$0] > silenceDb && !($0 < mask.count && mask[$0]) }.map { envelope[$0] }
        guard !speech.isEmpty else { return 1 }
        let meanPower = speech.map { pow(10, $0 / 10) }.reduce(0, +) / Double(speech.count)
        let levelDb = 10 * log10(meanPower)
        let peakDb = samplePeak > 0 ? 20 * log10(Double(samplePeak)) : (speech.max() ?? levelDb) + 12 // speech peaks ~12 dB over RMS
        let gainDb = min(targetDb - levelDb, -1 - peakDb, maxNoiseDb - noiseFloor(envelope), maxGainDb)
        return Float(pow(10, max(0, gainDb) / 20))
    }

    /// Below this (dBFS) for at least half a second, a track is silenced before recognition: much
    /// quieter than soft speech, so quiet words are never cut.
    public static let gateDb = -58.0
    public static let gateMinFrames = 50

    /// Silencing only ever covers whole stretches: runs shorter than `minRun` frames (300 ms) are
    /// dropped, so syllables and word endings inside speech are never cut out (choppy audio makes
    /// a speech model misread words and even guess the wrong language).
    public static func stretches(_ mask: [Bool], minRun: Int = 30) -> [Bool] {
        var out = [Bool](repeating: false, count: mask.count)
        var i = 0
        while i < mask.count {
            guard mask[i] else { i += 1; continue }
            var j = i
            while j < mask.count, mask[j] { j += 1 }
            if j - i >= minRun { for k in i..<j { out[k] = true } }
            i = j
        }
        return out
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

    /// On slices: no copies (this runs once per 10 ms frame over a whole meeting).
    static func pearson<A: Collection, B: Collection>(_ a: A, _ b: B) -> Double where A.Element == Double, B.Element == Double {
        let count = min(a.count, b.count)
        guard count > 0 else { return 0 }
        let n = Double(count)
        var sa = 0.0, sb = 0.0
        for (x, y) in zip(a, b) { sa += x; sb += y }
        let ma = sa / n, mb = sb / n
        var num = 0.0, da = 0.0, db = 0.0
        for (x0, y0) in zip(a, b) {
            let x = x0 - ma, y = y0 - mb
            num += x * y; da += x * x; db += y * y
        }
        let den = (da * db).squareRoot()
        return den > 1e-9 ? num / den : 0
    }

    /// Keeps the lines that are real speech: drops "You" lines that echo the call audio, and any
    /// line whose own track is silent for its whole time. Envelopes are indexed by frame. Silence
    /// is judged on `heard` when given (what the recognizer heard: the silenced parts removed, before
    /// gain, so room noise that gain lifted still counts as silence).
    public static func filter(_ segments: [Transcript.Segment], mic: [Double]?, system: [Double]?,
                              heard: (mic: [Double]?, system: [Double]?)? = nil) -> [Transcript.Segment] {
        segments.filter { segment in
            // Fragments like "अ" or "-" are noise, not speech (a single CJK character is a word: kept).
            guard isSpeechText(segment.text) else { return false }
            let track = segment.speaker == "You" ? (heard?.mic ?? mic) : (heard?.system ?? system)
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
