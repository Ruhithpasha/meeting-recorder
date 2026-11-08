// Transcribes a recording on this Mac with Apple's on-device SpeechTranscriber (macOS 26+).
//
//   MeetingRecorderTranscriber <recording.mp4> <output dir> [--locale en_US]
//
//   recording.mp4 ── audio track 1 (system: "Others") ─┐  AVAssetReader → analyzer's PCM format
//                └─ audio track 2 (mic: "You")       ─┴─▶ SpeechAnalyzer + SpeechTranscriber ─▶ segments
//                                                         merged by time ─▶ transcript.json + .vtt
//
// Separate tracks give speaker labels for free. The heavy lifting runs in Apple's speech service,
// not in this process. Progress goes to stdout as JSON lines: {"percent":42}.
// Exit 3 is reserved for "transcription can't work on this Mac" (OS version, language).
// Exit codes: 0 done, 2 bad input, 3 unavailable (OS/locale), 4 failed.
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
guard args.count >= 3 else { fail(2, "usage: MeetingRecorderTranscriber <recording.mp4> <output dir> [--locale id]") }
let input = URL(fileURLWithPath: args[1])
let outputDir = URL(fileURLWithPath: args[2])
let localeId = args.firstIndex(of: "--locale").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }

guard #available(macOS 26.0, *) else { fail(3, "Transcription needs macOS 26 or later.") }

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
        // One track at a time, copied to a small audio file. The analyzer then
        // reads the file at its own pace, so memory stays flat even for a 3-hour meeting.
        let exported: URL
        do { exported = try await exportTrack(track, of: asset, to: scratch.appendingPathComponent("track\(index).m4a")) }
        catch { throw StepError(step: "copying audio track \(index + 1)", underlying: error) }
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
    return Transcript(language: locale.identifier, durationSec: duration, segments: segments)
}

struct StepError: LocalizedError {
    let step: String
    let underlying: Error
    var errorDescription: String? { "\(step): \((underlying as NSError).localizedDescription) (\((underlying as NSError).domain) \((underlying as NSError).code))" }
}

/// Copies one audio track into its own .m4a (fast, small, no PCM held in memory).
@available(macOS 26.0, *)
func exportTrack(_ track: AVAssetTrack, of asset: AVAsset, to url: URL) async throws -> URL {
    let composition = AVMutableComposition()
    guard let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
        throw CocoaError(.fileWriteUnknown)
    }
    let range = try await track.load(.timeRange)
    try audio.insertTimeRange(range, of: track, at: range.start)
    // AppleM4A re-encodes to AAC (fast for audio). Passthrough isn't supported for these tracks
    // (AVFoundation -11838), and either way the data streams through disk, not memory.
    guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A) else {
        throw CocoaError(.fileWriteUnknown)
    }
    try await export.export(to: url, as: .m4a)
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
