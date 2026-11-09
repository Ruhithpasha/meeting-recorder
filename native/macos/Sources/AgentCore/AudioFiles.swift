// Reading and writing extracted audio tracks for the after-meeting transcriber (AVFoundation
// file I/O; AgentCoreChecks drives these with real files).
import AVFoundation

public enum AudioFiles {
    /// A track's loudness envelope (AudioEvidence frames) and each frame's loudest sample, read in
    /// 10 s chunks (flat memory). nil when the file can't be read as audio.
    public static func levels(_ url: URL) -> (envelope: [Double], peaks: [Float])? {
        guard let file = try? AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false) else { return nil }
        let rate = file.processingFormat.sampleRate
        let frame = max(1, Int(rate) / AudioEvidence.framesPerSecond)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(frame * 1_000)) else { return nil }
        var envelope: [Double] = [], peaks: [Float] = []
        while file.framePosition < file.length {
            guard (try? file.read(into: buffer)) != nil, buffer.frameLength > 0, let data = buffer.floatChannelData?[0] else { return nil }
            let samples = Array(UnsafeBufferPointer(start: data, count: Int(buffer.frameLength)))
            envelope += AudioEvidence.envelope(samples, sampleRate: rate)
            peaks += stride(from: 0, to: samples.count, by: frame).map { start in
                samples[start..<min(samples.count, start + frame)].reduce(0) { max($0, abs($1)) }
            }
        }
        return (envelope, peaks)
    }

    /// Copies a track, silencing `silence` frames and applying `gain` (clamped to ±1), chunk by chunk.
    /// Silenced frames are fully silent (no echo onset leaks); a kept frame next to one fades over its
    /// first or last 2 ms, so the cut doesn't click and your next word keeps its start.
    public static func writeCleaned(from source: URL, to target: URL, gain: Float, silence: [Bool]) throws {
        let input = try AVAudioFile(forReading: source, commonFormat: .pcmFormatFloat32, interleaved: false)
        let output = try AVAudioFile(forWriting: target, settings: input.fileFormat.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let frameSize = max(1, Int(input.processingFormat.sampleRate) / AudioEvidence.framesPerSecond)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: AVAudioFrameCount(frameSize * 1_000)) else {
            throw CocoaError(.fileWriteUnknown)
        }
        func silent(_ frame: Int) -> Bool { frame >= 0 && frame < silence.count && silence[frame] }
        let ramp = max(1, frameSize / 5) // 2 ms
        var position = 0
        while input.framePosition < input.length {
            try input.read(into: buffer)
            let count = Int(buffer.frameLength)
            guard count > 0, let data = buffer.floatChannelData?[0] else { break }
            var i = 0
            while i < count {
                let sample = position + i
                let frame = sample / frameSize
                let end = min(count, i + (frameSize - sample % frameSize))
                let mute = silent(frame), fadeIn = silent(frame - 1), fadeOut = silent(frame + 1)
                for k in i..<end {
                    guard !mute else { data[k] = 0; continue }
                    let offset = (position + k) % frameSize
                    var level = gain
                    if fadeIn, offset < ramp { level *= Float(offset) / Float(ramp) }
                    if fadeOut, frameSize - offset <= ramp { level *= Float(frameSize - offset - 1) / Float(ramp) }
                    data[k] = max(-1, min(1, data[k] * level))
                }
                i = end
            }
            try output.write(from: buffer)
            position += count
        }
    }
}
