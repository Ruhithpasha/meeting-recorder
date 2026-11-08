// Spike T1: prove screen + system audio + mic capture to a crash-safe fragmented MP4 on macOS 15+.
// Throwaway code. It answers the design doc's open questions; it is not the production agent.
//
//   SCStream (one clock) ──┬── .screen      ─▶ H.264 720p/15fps, keyframe every 5 s ─┐
//                          ├── .audio       ─▶ AAC track 1 "system"                  ─┼─▶ AVAssetWriter, fragment every 5 s
//                          └── .microphone  ─▶ AAC track 2 "mic"                     ─┘      └─▶ output.mp4
//
// Build: swiftc -O -swift-version 5 record.swift -o record
// Run:   ./record [seconds=60] [output=spike-recording.mp4]     (refuses to overwrite an existing file)
// Test:  ./record --self-test                                     (pure-logic checks, no capture)

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let targetHeight = 720
let framesPerSecond: Int32 = 15
let fragmentSeconds = 5.0
let statusIntervalSeconds = 5.0
let maxFirstFrameAgeMs = 500.0
/// 90% of the frame period, so frames that arrive slightly early are not wrongly dropped.
let minFrameSpacingSeconds = 0.9 / Double(framesPerSecond)

// MARK: - Pure logic (covered by --self-test)

/// Parses the duration argument. Rejects non-numbers, NaN, infinity, zero and negatives.
func parseDuration(_ raw: String?) -> Double? {
    guard let raw else { return 60 }
    guard let value = Double(raw), value.isFinite, value > 0 else { return nil }
    return value
}

/// Width that keeps the display's aspect ratio at `height`, rounded to an even number (H.264 requirement).
func evenWidth(displayWidth: Int, displayHeight: Int, height: Int) -> Int {
    precondition(displayWidth > 0 && displayHeight > 0 && height > 0)
    return max(2, Int((Double(height) * Double(displayWidth) / Double(displayHeight) / 2).rounded()) * 2)
}

enum Track: Int, CaseIterable {
    case video, system, mic
    var label: String { ["video", "system", "mic"][rawValue] }
}

/// Per-track counters and timestamps. Fixed-size arrays indexed by `Track`, so no string-key typos.
struct TrackStats {
    var appended = [Int](repeating: 0, count: Track.allCases.count)
    var dropped = [Int](repeating: 0, count: Track.allCases.count)
    var first = [CMTime](repeating: .invalid, count: Track.allCases.count)
    var last = [CMTime](repeating: .invalid, count: Track.allCases.count)

    mutating func record(_ track: Track, pts: CMTime, appended ok: Bool) {
        let i = track.rawValue
        if !first[i].isValid { first[i] = pts }
        last[i] = pts
        if ok { appended[i] += 1 } else { dropped[i] += 1 }
    }

    /// Running sync check: how far the mic's newest sample is from the system audio's newest sample.
    /// Both audio streams deliver continuously, so a value that grows over the run means drift.
    func micMinusSystemMs() -> Double? {
        let mic = last[Track.mic.rawValue], system = last[Track.system.rawValue]
        guard mic.isValid, system.isValid else { return nil }
        return CMTimeSubtract(mic, system).seconds * 1000
    }
}

func runSelfTest() -> Int32 {
    var failures = 0
    func check(_ condition: Bool, _ name: String) {
        print("\(condition ? "PASS" : "FAIL") \(name)")
        if !condition { failures += 1 }
    }
    check(parseDuration(nil) == 60, "duration defaults to 60")
    check(parseDuration("42") == 42, "duration parses 42")
    check(parseDuration("0") == nil, "duration rejects 0")
    check(parseDuration("-5") == nil, "duration rejects negative")
    check(parseDuration("inf") == nil, "duration rejects inf")
    check(parseDuration("nan") == nil, "duration rejects nan")
    check(parseDuration("abc") == nil, "duration rejects text")
    check(evenWidth(displayWidth: 1920, displayHeight: 1080, height: 720) == 1280, "16:9 -> 1280")
    check(evenWidth(displayWidth: 1512, displayHeight: 982, height: 720) == 1108, "MacBook 14 -> even 1108")
    check(evenWidth(displayWidth: 1, displayHeight: 1000, height: 720) == 2, "tiny width clamps to 2")
    for w in [1440, 1470, 1512, 1728, 2560] {
        check(evenWidth(displayWidth: w, displayHeight: 900, height: 720) % 2 == 0, "width \(w) result is even")
    }
    var stats = TrackStats()
    check(stats.micMinusSystemMs() == nil, "sync unknown before samples")
    stats.record(.system, pts: CMTime(seconds: 10.0, preferredTimescale: 48_000), appended: true)
    stats.record(.mic, pts: CMTime(seconds: 10.02, preferredTimescale: 48_000), appended: true)
    stats.record(.mic, pts: CMTime(seconds: 10.05, preferredTimescale: 48_000), appended: false)
    check(abs((stats.micMinusSystemMs() ?? 0) - 50) < 0.5, "sync uses latest timestamps (50 ms)")
    check(stats.appended[Track.mic.rawValue] == 1 && stats.dropped[Track.mic.rawValue] == 1, "counts appended vs dropped")
    print(failures == 0 ? "SELF-TEST OK" : "SELF-TEST FAILED (\(failures))")
    return failures == 0 ? 0 : 1
}

/// Physical footprint in MB, the same number Activity Monitor's "Memory" column shows.
func physicalFootprintMB() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    return result == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
}

// MARK: - Capture

final class SpikeRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: AVAssetWriter
    private let inputs: [AVAssetWriterInput] // indexed by Track.rawValue
    let sampleQueue = DispatchQueue(label: "spike.capture")

    // Touched only on sampleQueue.
    private var sessionStart: CMTime?
    private var writerFailed = false
    private var lastVideoPTS: CMTime?
    private var stats = TrackStats()

    init(url: URL, width: Int, height: Int) throws {
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        // Fragmented MP4: a kill -9 leaves a file playable up to the last complete fragment.
        writer.movieFragmentInterval = CMTime(seconds: fragmentSeconds, preferredTimescale: 600)

        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 1_500_000,
                // Time-based, not frame-based: ScreenCaptureKit skips frames on a static screen,
                // so a frame count could leave keyframes minutes apart and break crash recovery.
                AVVideoMaxKeyFrameIntervalDurationKey: fragmentSeconds,
                AVVideoExpectedSourceFrameRateKey: Int(framesPerSecond),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        func aacSettings(channels: Int) -> [String: Any] {
            [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
             AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: 64_000 * channels]
        }
        let system = AVAssetWriterInput(mediaType: .audio, outputSettings: aacSettings(channels: 2))
        let mic = AVAssetWriterInput(mediaType: .audio, outputSettings: aacSettings(channels: 1))
        inputs = [video, system, mic]

        for input in inputs {
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw SpikeError.writerSetup("cannot add \(input.mediaType.rawValue) input") }
            writer.add(input)
        }
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard buffer.isValid, !writerFailed else { return }
        let track: Track
        switch type {
        case .screen:
            // Idle/blank frames carry no image; only complete frames are encoded.
            guard isCompleteFrame(buffer) else { return }
            track = .video
        case .audio: track = .system
        case .microphone: track = .mic
        @unknown default: return
        }
        let pts = buffer.presentationTimeStamp

        // The session starts on the first video frame, so the file never opens on a black frame.
        // startWriting() is called exactly once; a second call on a failed writer raises an exception.
        if sessionStart == nil {
            guard track == .video else { return }
            // A first frame can carry a stale timestamp (a cached frame from before capture started),
            // which would open the file on seconds of frozen video. Only start on a fresh frame.
            let ageMs = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts).seconds * 1000
            guard ageMs < maxFirstFrameAgeMs else {
                print(String(format: "skip stale first frame (%.0f ms old)", ageMs)); return
            }
            guard writer.startWriting() else { return failWriter("failed to start") }
            writer.startSession(atSourceTime: pts)
            sessionStart = pts
            print(String(format: "session started on frame %.0f ms old", ageMs))
        }
        guard let start = sessionStart, pts >= start else { return }

        // Pace video ourselves: minimumFrameInterval is not always honored, and extra frames cost CPU and disk.
        if track == .video {
            if let last = lastVideoPTS, CMTimeSubtract(pts, last).seconds < minFrameSpacingSeconds { return }
            lastVideoPTS = pts
        }

        let input = inputs[track.rawValue]
        let ok = input.isReadyForMoreMediaData && input.append(buffer)
        stats.record(track, pts: pts, appended: ok)
        if !ok, writer.status == .failed { failWriter("failed mid-recording on \(track.label)") }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("ERROR stream stopped: \(error.localizedDescription)")
    }

    /// Prints the writer error once, loudly, and stops feeding it. Called on sampleQueue.
    private func failWriter(_ context: String) {
        guard !writerFailed else { return }
        writerFailed = true
        print("ERROR writer \(context): \(writer.error?.localizedDescription ?? "unknown error")")
    }

    private func isCompleteFrame(_ buffer: CMSampleBuffer) -> Bool {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let rawStatus = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: rawStatus)
        else { return false }
        return status == .complete && CMSampleBufferGetImageBuffer(buffer) != nil
    }

    /// One status line: footprint, per-track appended/dropped, and the running mic-vs-system offset.
    func statusLine(elapsed: Double) -> String {
        sampleQueue.sync {
            let counts = Track.allCases.map { "\($0.label)=\(stats.appended[$0.rawValue])/\(stats.dropped[$0.rawValue])dropped" }
            let sync = stats.micMinusSystemMs().map { String(format: "mic-system=%+.0fms", $0) } ?? "mic-system=n/a"
            return String(format: "t=%5.1fs footprint=%6.1fMB ", elapsed, physicalFootprintMB())
                + counts.joined(separator: " ") + " " + sync + (writerFailed ? " WRITER-FAILED" : "")
        }
    }

    func finish() async -> Bool {
        let canFinish: Bool = sampleQueue.sync {
            // Inputs may only be finished on a writer that actually started writing.
            guard writer.status == .writing else { return false }
            inputs.forEach { $0.markAsFinished() }
            return true
        }
        guard canFinish else {
            print("ERROR writer status \(writer.status.rawValue): \(writer.error?.localizedDescription ?? "never started (no complete video frames?)")")
            return false
        }
        await writer.finishWriting()
        return writer.status == .completed
    }
}

enum SpikeError: Error { case writerSetup(String) }

func run(durationSeconds: Double, outputURL: URL) async -> Int32 {
    // Never overwrite: crash-test evidence or a user's file must not be lost.
    guard !FileManager.default.fileExists(atPath: outputURL.path) else {
        print("ERROR \(outputURL.path) already exists. Pick another name or delete it yourself.")
        return 64
    }

    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    } catch {
        print("""
        ERROR could not read screen content: \(error.localizedDescription)
        Grant Screen Recording (and Microphone) to your terminal app in
        System Settings > Privacy & Security, then quit and reopen the terminal.
        """)
        return 2
    }
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
        print("ERROR no display found"); return 2
    }

    let width = evenWidth(displayWidth: display.width, displayHeight: display.height, height: targetHeight)
    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = targetHeight
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: framesPerSecond)
    configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    configuration.queueDepth = 5
    configuration.showsCursor = true
    configuration.capturesAudio = true
    configuration.excludesCurrentProcessAudio = true
    configuration.sampleRate = 48_000
    configuration.channelCount = 2
    configuration.captureMicrophone = true // macOS 15+: mic on the same clock as the screen

    let recorder: SpikeRecorder
    do { recorder = try SpikeRecorder(url: outputURL, width: width, height: targetHeight) } catch {
        print("ERROR \(error)"); return 1
    }
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let stream = SCStream(filter: filter, configuration: configuration, delegate: recorder)
    do {
        for type in [SCStreamOutputType.screen, .audio, .microphone] {
            try stream.addStreamOutput(recorder, type: type, sampleHandlerQueue: recorder.sampleQueue)
        }
        try await stream.startCapture()
    } catch {
        print("ERROR could not start capture: \(error.localizedDescription)"); return 2
    }

    print(String(format: "Recording %dx%d@%dfps for %.1fs to %@ (pid %d)",
                 width, targetHeight, framesPerSecond, durationSeconds, outputURL.path, getpid()))
    print("Play a video with sound and talk. Try `kill -9 \(getpid())` around t=40s to test crash survival.")
    let started = Date()
    while true {
        let remaining = durationSeconds - Date().timeIntervalSince(started)
        guard remaining > 0 else { break }
        try? await Task.sleep(nanoseconds: UInt64(min(statusIntervalSeconds, remaining) * 1_000_000_000))
        print(recorder.statusLine(elapsed: Date().timeIntervalSince(started)))
    }

    try? await stream.stopCapture()
    let ok = await recorder.finish()
    print(ok ? "DONE wrote \(outputURL.path). Run ./probe on it, then open it in QuickTime."
             : "FAILED see errors above")
    return ok ? 0 : 1
}

// MARK: - Entry point

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--self-test" { exit(runSelfTest()) }
guard let duration = parseDuration(arguments.first) else {
    print("usage: record [seconds > 0] [output.mp4] | record --self-test"); exit(64)
}
let output = URL(fileURLWithPath: arguments.count > 1 ? arguments[1] : "spike-recording.mp4")
exit(await run(durationSeconds: duration, outputURL: output))
