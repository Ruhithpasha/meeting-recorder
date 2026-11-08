// Live transcript while recording, with Apple's on-device SpeechTranscriber (macOS 26). The model
// runs in a system process (light on our memory and CPU). Two analyzers: the call's audio
// ("Others") and the microphone ("You"), fed the same audio the recorder writes.
//
//   capture queue ─▶ feed(buffer) ─▶ own serial queue: convert to the analyzer's format ─▶ AnalyzerInput
//   results (final only) ─▶ onSegment (sent to the daemon, shown in the dashboard as it happens)
//   finish() ─▶ transcript.json next to the recording (cleaned: echo removed, fragments merged),
//              so the transcript is ready the moment the meeting ends.
//
// Best effort: any failure turns live transcription off for this meeting and the recording goes
// on untouched. transcript.json is written only when the live transcript covers the whole
// meeting (it started with the recording and nothing failed); otherwise nothing is written and
// the usual after-meeting transcription covers it.
import AgentCore
import AVFoundation
import Foundation
import Speech

@available(macOS 26.0, *)
final class LiveTranscriber: @unchecked Sendable {
    var onSegment: ((Transcript.Segment) -> Void)?

    private final class Track {
        let speaker: String
        let transcriber: SpeechTranscriber
        let analyzer: SpeechAnalyzer
        let format: AVAudioFormat
        let input: AsyncStream<AnalyzerInput>.Continuation
        var converter: AVAudioConverter?
        var results: Task<Void, Never>?
        init(speaker: String, transcriber: SpeechTranscriber, analyzer: SpeechAnalyzer, format: AVAudioFormat, input: AsyncStream<AnalyzerInput>.Continuation) {
            self.speaker = speaker; self.transcriber = transcriber; self.analyzer = analyzer; self.format = format; self.input = input
        }
    }

    private let queue = DispatchQueue(label: "live-transcriber", qos: .utility)
    private var tracks: [Track] = []          // [Others, You]
    private var segments: [Transcript.Segment] = []
    private var failed = false
    private var firstFed: Double?             // seconds into the recording of the first audio fed
    /// Audio this far in (or later) at the first feed means the beginning was missed.
    static let maxMissedStartSeconds = 2.0
    let locale: Locale

    private init(locale: Locale) { self.locale = locale }

    /// nil when live transcription can't run now (language unsupported, model not installed yet:
    /// that one is requested in the background, for next time).
    static func start(localeId: String?) async -> LiveTranscriber? {
        let wanted = localeId.flatMap { $0 == "auto" ? nil : Locale(identifier: $0) } ?? .current
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: wanted) else { return nil }
        let probe = SpeechTranscriber(locale: locale, preset: .transcription)
        if let request = try? await AssetInventory.assetInstallationRequest(supporting: [probe]) {
            Task.detached(priority: .background) { try? await request.downloadAndInstall() } // ready next meeting
            return nil
        }
        let live = LiveTranscriber(locale: locale)
        do {
            for speaker in ["Others", "You"] {
                let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
                let analyzer = SpeechAnalyzer(modules: [transcriber])
                guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { return nil }
                let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
                try await analyzer.start(inputSequence: stream)
                let track = Track(speaker: speaker, transcriber: transcriber, analyzer: analyzer, format: format, input: input)
                track.results = Task { [weak live] in
                    do {
                        for try await result in transcriber.results where result.isFinal {
                            let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !text.isEmpty else { continue }
                            live?.add(.init(start: result.range.start.seconds, end: result.range.end.seconds, speaker: speaker, text: text))
                        }
                    } catch {
                        Log.warn("live transcript (\(speaker)) stopped: \(error.localizedDescription)")
                        live?.markFailed()
                    }
                }
                live.tracks.append(track)
            }
        } catch {
            Log.warn("live transcript unavailable: \(error.localizedDescription)")
            return nil
        }
        return live
    }

    /// Audio for track 0 (Others) or 1 (You); `seconds` is its time since the recording started.
    /// Called on the capture queue: the work happens on our own queue.
    func feed(_ buffer: CMSampleBuffer, track index: Int, seconds: Double) {
        queue.async { [self] in
            guard !failed, tracks.indices.contains(index) else { return }
            if firstFed == nil { firstFed = seconds }
            let track = tracks[index]
            guard let pcm = Self.convert(buffer, to: track.format, using: &track.converter) else { return }
            track.input.yield(AnalyzerInput(buffer: pcm, bufferStartTime: CMTime(seconds: seconds, preferredTimescale: 48_000)))
        }
    }

    /// Finishes both analyzers and, when the live transcript covers the whole meeting, writes
    /// transcript.json into `directory`. Returns the line count written, or nil if none was.
    func finish(writingTo directory: URL, durationSec: Double) async -> Int? {
        await withCheckedContinuation { done in queue.async { done.resume() } } // feeds already queued go first
        for track in tracks {
            track.input.finish()
            try? await track.analyzer.finalizeAndFinishThroughEndOfInput()
            await track.results?.value
        }
        let (all, complete): ([Transcript.Segment], Bool) = queue.sync {
            (segments, !failed && (firstFed ?? .infinity) < Self.maxMissedStartSeconds)
        }
        guard complete else { return nil }
        let transcript = Transcript(language: locale.identifier, durationSec: durationSec, segments: TranscriptCleanup.clean(all))
        do {
            try transcript.write(to: directory)
        } catch {
            Log.warn("live transcript couldn't be saved: \(error.localizedDescription)")
            return nil
        }
        return transcript.segments.count
    }

    /// Stops feeding: what's been transcribed so far is still shown, but not saved as the transcript.
    func markFailed() { queue.async { [self] in failed = true } }

    private func add(_ segment: Transcript.Segment) {
        queue.async { [self] in segments.append(segment) }
        onSegment?(segment)
    }

    private static func convert(_ buffer: CMSampleBuffer, to format: AVAudioFormat, using converter: inout AVAudioConverter?) -> AVAudioPCMBuffer? {
        guard let description = buffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description)?.pointee else { return nil }
        var streamDescription = asbd
        guard let sourceFormat = AVAudioFormat(streamDescription: &streamDescription) else { return nil }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(buffer))
        guard frames > 0, let source = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: frames) else { return nil }
        source.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(buffer, at: 0, frameCount: Int32(frames), into: source.mutableAudioBufferList) == noErr else { return nil }
        if sourceFormat == format { return source }
        if converter == nil || converter?.inputFormat != sourceFormat { converter = AVAudioConverter(from: sourceFormat, to: format) }
        guard let converter else { return nil }
        let capacity = AVAudioFrameCount(Double(frames) * format.sampleRate / sourceFormat.sampleRate) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return source
        }
        return error == nil && output.frameLength > 0 ? output : nil
    }
}
