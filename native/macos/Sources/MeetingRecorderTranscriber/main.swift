// Transcribes and summarizes recordings on this Mac, with Apple's models (macOS 26+) or open
// models from Hugging Face (OpenModels.swift), and makes share copies. The daemon runs it at
// background priority, only when the Mac is idle and plugged in (share copies: on request).
//
//   MeetingRecorderTranscriber <recording.mp4> <output dir> [--locale en_US] [--engine whisper --models <dir>]
//   MeetingRecorderTranscriber --summarize <meeting dir> [--engine qwen --models <dir>]   (Summarizer.swift)
//   MeetingRecorderTranscriber --merge <meeting dir>     parts.json streams ─▶ recording.mp4 (Merger.swift)
//   MeetingRecorderTranscriber --export <recording.mp4> <share.mp4>                       (Exporter.swift)
//   MeetingRecorderTranscriber --model-status --models <dir>   {"whisper":bool,"qwen":bool}
//   MeetingRecorderTranscriber --prepare whisper|qwen --models <dir>   download (+ prepare) ahead of time
//   MeetingRecorderTranscriber --capabilities    {"locales":[…],"whisperLanguages":[…],"whisper":reason|null,"qwen":reason|null}
//
//   recording.mp4 ── audio track 1 (system: "Others") ─┐  AVAssetReader → analyzer's PCM format
//                └─ audio track 2 (mic: "You")       ─┴─▶ SpeechAnalyzer + SpeechTranscriber ─▶ segments
//                                                         merged by time ─▶ transcript.json + .vtt
//
// Separate tracks give speaker labels for free. The heavy lifting runs in Apple's speech service,
// not in this process. Progress goes to stdout as JSON lines: {"percent":42}.
// Exit codes: 0 done · 2 bad input · 3 unavailable on this Mac (OS, language, Apple Intelligence off)
//             4 failed (worth retrying) · 5 not ready yet (e.g. model still downloading: retry later)
//             6 failed for good on this input (e.g. the model declined): don't retry
import AVFoundation
import AgentCore
import Foundation
import Speech

func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

func fail(_ code: Int32, _ message: String) -> Never {
    emit(["error": message])
    exit(code)
}

let args = CommandLine.arguments

func option(_ name: String) -> String? {
    args.firstIndex(of: name).flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
}
let engine = option("--engine") ?? "apple"
let modelsDir = URL(fileURLWithPath: option("--models") ?? NSString(string: "~/.meeting-recorder/models").expandingTildeInPath)

/// "The operation could not be completed" hides the cause: keep domain/code and the underlying error.
func describe(_ error: Error) -> String {
    let ns = error as NSError
    var text = "\(ns.localizedDescription) [\(ns.domain) \(ns.code)]"
    if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
        text += " caused by [\(underlying.domain) \(underlying.code)] \(underlying.localizedDescription)"
    }
    return text
}

/// Runs one async job and exits with its code (model downloads: 5 or 6; other errors: 4, worth retrying).
func runJob(_ failure: String, _ body: @escaping @Sendable () async throws -> [String: Any]) -> Never {
    Task {
        do {
            emit(try await body())
            exit(0)
        } catch {
            DownloadError.exitIfDownload(error)
            fail(4, "\(failure): \(describe(error))")
        }
    }
    dispatchMain()
}

if args.count >= 2, args[1] == "--capabilities" {
    runJob("Capabilities failed") {
        var locales: [String] = []
        if #available(macOS 26.0, *) { locales = await SpeechTranscriber.supportedLocales.map(\.identifier).sorted() }
        return ["locales": locales, "whisperLanguages": OpenModels.whisperLanguages,
                "whisper": OpenModels.whisperUnavailable ?? NSNull(), "qwen": OpenModels.qwenUnavailable ?? NSNull()]
    }
}

// Open models: installed? (cheap: file checks only, no hashing, no network)
if args.count >= 2, args[1] == "--model-status" {
    emit(["whisper": OpenModels.whisperReady(models: modelsDir), "qwen": OpenModels.qwenReady(models: modelsDir)])
    exit(0)
}

// Download (and for Whisper, prepare for this Mac's chip) ahead of the first meeting.
if args.count >= 3, args[1] == "--prepare" {
    let which = args[2]
    if which == "whisper", let reason = OpenModels.whisperUnavailable { fail(3, reason) }
    if which == "qwen", let reason = OpenModels.qwenUnavailable { fail(3, reason) }
    runJob("Download failed") {
        if which == "whisper" {
            _ = try await WhisperTrackRecognizer(models: modelsDir, localeId: nil, preparing: true)
        } else {
            _ = try await OpenModels.qwenRuntime(models: modelsDir)
        }
        return ["done": true]
    }
}

if args.count >= 3, args[1] == "--merge" {
    runJob("Merging the recording failed") {
        let result = try await Merger.run(directory: URL(fileURLWithPath: args[2]))
        return ["done": true, "durationSec": result.durationSec, "merged": result.merged]
    }
}

if args.count >= 4, args[1] == "--export" {
    runJob("Making the copy failed") {
        try await Exporter.run(input: URL(fileURLWithPath: args[2]), output: URL(fileURLWithPath: args[3]))
        return ["done": true]
    }
}

if args.count >= 3, args[1] == "--summarize" {
    let directory = URL(fileURLWithPath: args[2])
    if engine == "qwen" {
        if let reason = OpenModels.qwenUnavailable { fail(3, reason) }
        runJob("Summary failed") {
            let runtime = try await OpenModels.qwenRuntime(models: modelsDir)
            try await Summarizer.run(directory: directory, model: QwenSummaryModel(binary: runtime.binary, model: runtime.model))
            return ["done": true]
        }
    }
    guard #available(macOS 26.0, *) else { fail(3, "Summaries with Apple's model need macOS 26 or later.") }
    AppleSummaryModel.checkAvailable()
    runJob("Summary failed") {
        try await Summarizer.run(directory: directory, model: AppleSummaryModel())
        return ["done": true]
    }
}

guard args.count >= 3 else { fail(2, "usage: MeetingRecorderTranscriber <recording.mp4> <output dir> [--locale id]") }
let input = URL(fileURLWithPath: args[1])
let outputDir = URL(fileURLWithPath: args[2])
let localeId = option("--locale")

/// Whisper path: the same per-track PCM and clean-up as Apple's, a different recognizer.
func transcribeWithWhisper() async throws -> Transcript {
    let asset = AVURLAsset(url: input)
    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    guard !audioTracks.isEmpty else { fail(2, "The recording has no audio.") }
    let duration = try await asset.load(.duration).seconds
    let recognizer = try await WhisperTrackRecognizer(models: modelsDir, localeId: localeId)
    let labels = Transcript.speakerLabels(trackCount: audioTracks.count)
    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("mr-transcribe-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: scratch) }
    var segments: [Transcript.Segment] = []
    for (index, track) in audioTracks.enumerated() {
        emit(["percent": index * 100 / audioTracks.count])
        let pcm: URL
        do { pcm = try await extractPCM(track, of: asset, to: scratch.appendingPathComponent("track\(index).caf")) }
        catch { throw StepError(step: "reading audio track \(index + 1)", underlying: error) }
        do { segments += try await recognizer.recognize(pcm, speaker: labels[index]) }
        catch { throw StepError(step: "transcribing audio track \(index + 1)", underlying: error) }
    }
    return Transcript(language: recognizer.language ?? "auto", durationSec: duration, segments: TranscriptCleanup.clean(segments))
}

if engine == "whisper" {
    if let reason = OpenModels.whisperUnavailable { fail(3, reason) }
    runJob("Transcription failed") {
        let transcript = try await transcribeWithWhisper()
        try transcript.write(to: outputDir)
        return ["done": true, "segments": transcript.segments.count]
    }
}

guard #available(macOS 26.0, *) else { fail(3, "Transcription with Apple's model needs macOS 26 or later.") }

@available(macOS 26.0, *)
func transcribe() async throws -> Transcript {
    let asset = AVURLAsset(url: input)
    let audioTracks = try await asset.loadTracks(withMediaType: .audio)
    guard !audioTracks.isEmpty else { fail(2, "The recording has no audio.") }
    let duration = try await asset.load(.duration).seconds

    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: localeId.map(Locale.init(identifier:)) ?? .current) else {
        fail(3, "Transcription doesn't support this language yet.") // exit 3: unavailable on this Mac
    }
    let labels = Transcript.speakerLabels(trackCount: audioTracks.count)
    let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("mr-transcribe-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: scratch) }
    var segments: [Transcript.Segment] = []

    for (index, track) in audioTracks.enumerated() {
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            emit(["status": "downloading-model"])
            try await request.downloadAndInstall()
        }
        // One track at a time, decoded once to uncompressed 16 kHz mono audio on disk (no second
        // lossy encode, which hurt accuracy). The analyzer reads it at its own pace: memory stays flat.
        let exported: URL
        do { exported = try await extractPCM(track, of: asset, to: scratch.appendingPathComponent("track\(index).caf")) }
        catch { throw StepError(step: "reading audio track \(index + 1)", underlying: error) }
        let audioFile: AVAudioFile
        do { audioFile = try AVAudioFile(forReading: exported) }
        catch { throw StepError(step: "opening audio track \(index + 1)", underlying: error) }
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let speaker = labels[index]

        let collector = Task { () -> [Transcript.Segment] in
            var found: [Transcript.Segment] = []
            var lastPercent = -1
            for try await result in transcriber.results where result.isFinal {
                let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    found.append(.init(start: result.range.start.seconds, end: result.range.end.seconds, speaker: speaker, text: text))
                }
                if duration > 0 { // progress = transcribed time, not decode speed
                    let percent = Int(((Double(index) + min(1, result.range.end.seconds / duration)) / Double(audioTracks.count) * 100).rounded(.down))
                    if percent >= lastPercent + 2 { emit(["percent": percent]); lastPercent = percent }
                }
            }
            return found
        }
        do {
            if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
                try await analyzer.finalizeAndFinish(through: lastSample)
            } else {
                await analyzer.cancelAndFinishNow() // silent or empty track
            }
        } catch { throw StepError(step: "transcribing audio track \(index + 1)", underlying: error) }
        segments += try await collector.value
    }
    return Transcript(language: locale.identifier, durationSec: duration, segments: TranscriptCleanup.clean(segments))
}

struct StepError: LocalizedError {
    let step: String
    let underlying: Error
    var errorDescription: String? { "\(step): \((underlying as NSError).localizedDescription) (\((underlying as NSError).domain) \((underlying as NSError).code))" }
}

/// Decodes one audio track to 16-bit, 16 kHz mono PCM in a temporary file, buffer by buffer.
/// AVAssetReader resamples and downmixes; nothing is re-encoded lossily and memory stays flat.
func extractPCM(_ track: AVAssetTrack, of asset: AVAsset, to url: URL) async throws -> URL {
    guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true) else {
        throw CocoaError(.fileWriteUnknown)
    }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
        AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
    ])
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? CocoaError(.fileReadUnknown) }
    let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatInt16, interleaved: true)
    // The file is laid out on the movie's timeline: a track that starts late, a gap, or a buffer
    // that can't be read becomes silence, so every transcript time matches the video.
    var written: AVAudioFramePosition = 0
    func writeSilence(_ count: AVAudioFramePosition) throws {
        var left = count
        while left > 0 {
            let chunk = AVAudioFrameCount(min(left, 16_000))
            guard let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { throw CocoaError(.fileWriteOutOfSpace) }
            silence.frameLength = chunk
            memset(silence.int16ChannelData![0], 0, Int(chunk) * MemoryLayout<Int16>.size)
            try file.write(from: silence)
            left -= AVAudioFramePosition(chunk)
        }
        written += count
    }
    while let sample = output.copyNextSampleBuffer() {
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sample))
        guard frames > 0 else { continue }
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        if pts.isNumeric {
            let at = AVAudioFramePosition((pts.seconds * 16_000).rounded())
            if at - written > 160 { try writeSilence(at - written) } // > 10 ms behind the timeline
        }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { throw CocoaError(.fileWriteOutOfSpace) }
        buffer.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList) == noErr else {
            try writeSilence(AVAudioFramePosition(frames)) // unreadable buffer: keep the timeline
            continue
        }
        try file.write(from: buffer)
        written += AVAudioFramePosition(frames)
    }
    if reader.status == .failed { throw reader.error ?? CocoaError(.fileReadCorruptFile) }
    return url
}

if #available(macOS 26.0, *) {
    Task {
        do {
            let transcript = try await transcribe()
            try transcript.write(to: outputDir)
            emit(["done": true, "segments": transcript.segments.count])
            exit(0)
        } catch {
            fail(4, "Transcription failed: \(error.localizedDescription)")
        }
    }
    dispatchMain()
}
