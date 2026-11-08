// Screen + system audio + mic capture, each stream to its OWN crash-safe file (RecordingParts).
//
//   SCStream (one clock) ──┬── .screen      ─▶ FramePacer ─▶ StreamWriter "video"  (H.264, keyframe / 5 s)
//                          ├── .audio       ─▶ AudioTimeline ─▶ StreamWriter "system" (AAC stereo)
//                          └── .microphone  ─▶ AudioTimeline ─▶ StreamWriter "mic"    (AAC mono)
//   each writer: fragmented MP4 parts + parts.json; the daemon merges them into recording.mp4
//
// Writing video and audio into one file while recording failed intermittently inside AVAssetWriter
// (-11800 / -16341) and took the whole meeting with it. Now a failing writer restarts only its own
// stream, at the next sample. Two separate audio tracks (no mixing) let transcription tell "You"
// (mic) from "Others" (system). The recording starts on the first FRESH complete frame.
// All mutable state lives on `queue` (the sample handler queue); callbacks hop to the main queue.
import AgentCore
import AVFoundation
import CoreMedia
import ScreenCaptureKit

/// @unchecked Sendable: mutable capture state lives only on `queue`; callbacks are set once at launch.
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    var onStarted: ((String) -> Void)?
    var onStopped: ((String, Double) -> Void)?
    var onError: ((String, AgentErrorCode, String) -> Void)?
    /// A finished line of the live transcript (meeting id, segment).
    var onTranscript: ((String, Transcript.Segment) -> Void)?

    private let queue = DispatchQueue(label: "recorder.capture", qos: .userInitiated)
    private var session: Session?
    /// Set synchronously by start() BEFORE the async setup, so a second start is refused and a stop
    /// that arrives during setup is remembered (on `queue`).
    private var preparing: (meetingId: String, stopRequested: Bool)?
    /// Signalled on `queue` when a finish completes; used by stopAndWait during app termination,
    /// where main-queue callbacks can't run.
    private var finished: ((String, Double?, RecorderError?) -> Void)?

    /// @unchecked Sendable: only touched on the recorder's serial `queue`.
    private final class Session: @unchecked Sendable {
        let meetingId: String
        let directory: URL
        var writers: [StreamWriter] = []   // video, system, mic
        var manifest = PartsManifest()
        var stream: SCStream?
        var pacer: FramePacer
        var startPTS: CMTime?
        var lastPTS: CMTime = .invalid
        var finishing = false
        var startedReported = false
        var formats: [CMFormatDescription?] = [nil, nil, nil]
        var formatChanges = [0, 0, 0]
        var timelines = [AudioTimeline(), AudioTimeline(), AudioTimeline()] // audio inputs 1, 2
        let audioCopies = [AudioCopy(), AudioCopy(), AudioCopy()]
        var live: AnyObject?             // LiveTranscriber (macOS 26), when live transcription runs

        init(meetingId: String, directory: URL, fps: Int) {
            self.meetingId = meetingId
            self.directory = directory
            self.pacer = FramePacer(fps: fps)
        }

        func diagnostics() -> String {
            writers.map { $0.diagnostics(start: startPTS ?? .zero) }.joined(separator: "; ")
        }
    }

    /// The meeting being recorded right now (frames flowing), for hello after a daemon restart.
    var activeMeetingId: String? { queue.sync { session?.startPTS != nil ? session?.meetingId : nil } }
    var isBusy: Bool { queue.sync { session != nil || preparing != nil } }

    func start(meetingId: String, path: String, height: Int, fps: Int, liveLocale: String? = nil) {
        let reserved: Bool = queue.sync {
            guard session == nil, preparing == nil else { return false }
            preparing = (meetingId, false)
            return true
        }
        guard reserved else {
            report { self.onError?(meetingId, .capture, "Already recording another meeting.") }
            return
        }
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
                    throw RecorderError.capture("No display found.")
                }
                let width = CaptureMath.evenWidth(displayWidth: display.width, displayHeight: display.height, height: height)
                let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
                let s = Session(meetingId: meetingId, directory: directory, fps: fps)
                let inputs = Self.inputFactories(width: width, height: height, fps: fps)
                s.writers = zip(PartsManifest.streams, inputs).map { name, makeInput in
                    StreamWriter(stream: name, directory: directory, makeInput: makeInput) { [weak s] part in
                        guard let s else { return false }
                        var next = s.manifest
                        next.parts.append(part)
                        do { try next.write(to: directory) } catch { Log.warn("parts.json couldn't be saved: \(error)"); return false }
                        s.manifest = next
                        return true
                    }
                }

                let config = SCStreamConfiguration()
                config.width = width
                config.height = height
                config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
                config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
                config.queueDepth = 5
                config.showsCursor = true
                config.capturesAudio = true
                config.excludesCurrentProcessAudio = true
                config.sampleRate = 48_000
                config.channelCount = 2
                config.captureMicrophone = true

                // Our own windows (the REC indicator, the dashboard) stay out of the recording.
                let own = content.applications.filter { $0.bundleIdentifier == Bundle.main.bundleIdentifier }
                let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
                let stream = SCStream(filter: filter, configuration: config, delegate: self)
                for type in [SCStreamOutputType.screen, .audio, .microphone] {
                    try stream.addStreamOutput(self, type: type, sampleHandlerQueue: queue)
                }
                s.stream = stream
                // Live transcript gets ready alongside capture, so it hears the meeting from the start.
                let live: Task<AnyObject?, Never>? = {
                    guard let liveLocale, #available(macOS 26.0, *) else { return nil }
                    return Task { await LiveTranscriber.start(localeId: liveLocale) }
                }()
                try await stream.startCapture()
                let liveTranscriber = await live?.value
                if #available(macOS 26.0, *), let lt = liveTranscriber as? LiveTranscriber {
                    lt.onSegment = { [weak self] segment in report { self?.onTranscript?(meetingId, segment) } }
                } else if liveLocale != nil {
                    Log.info("live transcript not available now for \(meetingId); it will be transcribed after the meeting")
                }
                let stopRequested: Bool = queue.sync {
                    let requested = self.preparing?.stopRequested ?? false
                    self.preparing = nil
                    s.live = liveTranscriber
                    self.session = s
                    return requested
                }
                Log.info("capture started for \(meetingId) at \(width)x\(height)@\(fps)")
                if stopRequested { queue.async { self.finish(s, error: nil) } } // stop arrived during setup
            } catch {
                queue.sync { self.preparing = nil; self.session = nil }
                // Nothing usable was recorded: remove any part already opened, and its manifest.
                let directory = URL(fileURLWithPath: path).deletingLastPathComponent()
                for name in PartsManifest.streams { for n in 1...9 { try? FileManager.default.removeItem(at: directory.appendingPathComponent("\(name)-\(n).mp4")) } }
                try? FileManager.default.removeItem(at: directory.appendingPathComponent(PartsManifest.fileName))
                let (code, message) = Self.classify(error)
                Log.warn("capture failed to start for \(meetingId): \(message)")
                report { self.onError?(meetingId, code, message) }
            }
        }
    }

    func stop(meetingId: String) {
        queue.async {
            if self.preparing?.meetingId == meetingId { self.preparing?.stopRequested = true; return }
            guard let s = self.session, s.meetingId == meetingId, !s.finishing else { return }
            self.finish(s, error: nil)
        }
    }

    /// App termination: finish the file before the process exits. Blocks the caller (main thread)
    /// on a semaphore signalled from the background, and returns the result for the caller to
    /// report synchronously: main-queue callbacks can't run while main is blocked.
    func stopAndWait(timeout: TimeInterval) -> (meetingId: String, durationSec: Double?, error: RecorderError?)? {
        let done = DispatchSemaphore(value: 0)
        var result: (String, Double?, RecorderError?)?
        let id: String? = queue.sync {
            guard let s = session else { return nil }
            finished = { id, duration, error in result = (id, duration, error); done.signal() }
            if !s.finishing { finish(s, error: nil) }
            return s.meetingId
        }
        guard id != nil, done.wait(timeout: .now() + timeout) == .success, let (meetingId, duration, error) = result else { return nil }
        return (meetingId, duration, error)
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard let s = session, !s.finishing, buffer.isValid else { return }
        let arrival = buffer.presentationTimeStamp
        let index: Int
        switch type {
        case .screen:
            guard Self.isCompleteFrame(buffer) else { return }
            index = 0
        case .audio: index = 1
        case .microphone: index = 2
        @unknown default: return
        }

        if s.startPTS == nil {
            guard index == 0 else { return }
            let age = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), arrival).seconds
            guard age < CaptureMath.maxFirstFrameAgeSeconds else { return } // stale cached frame
            s.startPTS = arrival
        }
        guard let start = s.startPTS, arrival >= start else { return }
        // Audio: placed on a continuous timeline (AudioTimeline) before the writer sees it.
        var sample = buffer
        var time = arrival
        if index != 0 {
            guard let asbd = buffer.formatDescription.flatMap({ CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }),
                  let placed = s.timelines[index].place(arrival: arrival, count: CMSampleBufferGetNumSamples(buffer), rate: asbd.mSampleRate),
                  CMTimeCompare(placed, start) >= 0 else { s.writers[index].dropped += 1; return }
            guard let copy = s.audioCopies[index].placed(buffer, at: placed, rate: asbd.mSampleRate, label: index == 1 ? "system" : "mic") else {
                s.writers[index].dropped += 1
                return
            }
            sample = copy
            time = placed
            if #available(macOS 26.0, *), let live = s.live as? LiveTranscriber {
                live.feed(sample, track: index - 1, seconds: CMTimeSubtract(time, start).seconds) // 0: Others, 1: You
            }
        }
        let pts = time
        let writer = s.writers[index]
        // A frame that doesn't move the video forward is dropped before the frame pacer, so a
        // duplicate doesn't use up a slot (the writer drops any other non-advancing sample).
        if index == 0, writer.lastAppended.isValid, CMTimeCompare(pts, writer.lastAppended) <= 0 {
            writer.dropped += 1
            return
        }
        if index == 0, !s.pacer.accept(pts) { return }
        // Real format changes only (size, sample rate, channels), not per-frame metadata. Pointer
        // check first: the same description object is reused frame after frame, so this is cheap.
        if let format = buffer.formatDescription, format !== s.formats[index] {
            if let previous = s.formats[index], Self.formatKey(previous) != Self.formatKey(format) {
                s.formatChanges[index] += 1
                if s.formatChanges[index] == 1 {
                    Log.warn("recording \(s.meetingId): input \(index) changed from \(Self.formatKey(previous)) to \(Self.formatKey(format)) at \(String(format: "%.2f", CMTimeSubtract(pts, start).seconds)) s")
                }
            }
            s.formats[index] = format
        }

        if writer.append(sample, at: pts, start: start, meetingId: s.meetingId) {
            if index == 0 || CMTimeCompare(pts, s.lastPTS) > 0 { s.lastPTS = pts }
            if !s.startedReported { // the first sample of any stream is in a file: tell the daemon
                s.startedReported = true
                let id = s.meetingId
                report { self.onStarted?(id) }
            }
        } else if s.writers.allSatisfy(\.gaveUp) {
            Log.warn("recording \(s.meetingId): every stream keeps failing; stopping. " + s.diagnostics())
            finish(s, error: .writer("The recorder couldn't write this meeting's files."))
        }
    }

    // MARK: SCStreamDelegate

    /// The system stopped capture (display unplugged, permission revoked, …): keep what we have.
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async {
            guard let s = self.session, !s.finishing else { return }
            Log.warn("stream stopped by the system: \(RecorderError.describe(error))")
            if s.startPTS == nil {
                self.finish(s, error: Self.classify(error).0 == .permission ? .permission(error.localizedDescription) : .capture(error.localizedDescription))
            } else {
                self.finish(s, error: nil) // a valid recording up to here: report it as stopped
            }
        }
    }

    // MARK: Finishing (on `queue`)

    private func finish(_ s: Session, error: RecorderError?) {
        s.finishing = true
        let id = s.meetingId
        let stream = s.stream
        let duration = s.startPTS.map { CMTimeSubtract(s.lastPTS, $0).seconds } ?? 0
        Task {
            try? await stream?.stopCapture()
            // Each stream finishes its current part; a part that can't keeps its saved fragments
            // and the daemon trims and merges it anyway.
            // On the capture queue, as StreamWriter requires; waits for every part to finish.
            await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
                self.queue.async {
                    let group = DispatchGroup()
                    for writer in s.writers { group.enter(); writer.finish { group.leave() } }
                    group.notify(queue: self.queue) { finished.resume() }
                }
            }
            let writers: [StreamWriter] = self.queue.sync { s.writers }
            // Then the live transcript (the video is safe first), at most 10 s, before "stopped" is
            // reported so the daemon finds transcript.json. Too slow: skipped, transcribed after.
            if #available(macOS 26.0, *), let live = s.live as? LiveTranscriber, s.startPTS != nil {
                let lines: Int?? = await withTaskGroup(of: Int??.self) { group in
                    group.addTask { .some(await live.finish(writingTo: s.directory, durationSec: max(0, duration))) }
                    group.addTask {
                        try? await Task.sleep(for: .seconds(10))
                        if !Task.isCancelled { live.markFailed() } // too slow: never write over the after-meeting transcript
                        return .none
                    }
                    let first = await group.next() ?? .none
                    group.cancelAll()
                    return first
                }
                Log.info("live transcript for \(id): " + (lines.flatMap { $0 }.map { "\($0) lines saved" } ?? "not saved (incomplete or too slow)"))
            }
            // Stopped before the first frame: nothing was recorded. Not an error: remove the empty
            // file and report a 0 s stop (the daemon then removes the empty meeting).
            let neverStarted = s.startPTS == nil && error == nil
            if neverStarted {
                for file in writers.flatMap(\.files) { try? FileManager.default.removeItem(at: file) }
                try? FileManager.default.removeItem(at: s.directory.appendingPathComponent(PartsManifest.fileName))
            }
            let outcome: (Double?, RecorderError?) = error.map { (nil, $0) } ?? (neverStarted ? 0 : max(0, duration), nil)
            let finished: ((String, Double?, RecorderError?) -> Void)? = self.queue.sync {
                self.session = nil
                defer { self.finished = nil }
                return self.finished
            }
            if let finished { return finished(id, outcome.0, outcome.1) } // termination path: caller reports
            if let error = outcome.1 {
                Log.warn("recording \(id) ended with error: \(error.message)")
                report { self.onError?(id, error.code, error.message) }
            } else {
                Log.info("recording \(id) finished, \(String(format: "%.1f", outcome.0 ?? 0)) s")
                report { self.onStopped?(id, outcome.0 ?? 0) }
            }
        }
    }

    // MARK: Helpers

    /// What matters to the writer about a format: codec, and size or sample rate / channels.
    private static func formatKey(_ format: CMFormatDescription) -> String {
        let codec = CMFormatDescriptionGetMediaSubType(format)
        if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee {
            return "audio \(codec) \(Int(asbd.mSampleRate)) Hz \(asbd.mChannelsPerFrame) ch flags \(asbd.mFormatFlags)"
        }
        let size = CMVideoFormatDescriptionGetDimensions(format)
        return "video \(codec) \(size.width)x\(size.height)"
    }

    /// Fresh writer inputs for each stream (a restarted part gets a new one): video, system, mic.
    private static func inputFactories(width: Int, height: Int, fps: Int) -> [() -> AVAssetWriterInput] {
        let video = {
            AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: CaptureMath.videoBitrate(height: height, fps: fps),
                    AVVideoMaxKeyFrameIntervalDurationKey: CaptureMath.fragmentSeconds, // time-based, see spike
                    AVVideoExpectedSourceFrameRateKey: fps,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ],
            ])
        }
        // Speech accuracy depends on the source: 160 kbps for everyone else (stereo), 96 kbps for your mic.
        func aac(_ channels: Int) -> () -> AVAssetWriterInput {
            { AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
                                                                       AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: channels == 2 ? 160_000 : 96_000]) }
        }
        return [video, aac(2), aac(1)]
    }

    private static func isCompleteFrame(_ buffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw)
        else { return false }
        return status == .complete && CMSampleBufferGetImageBuffer(buffer) != nil
    }

    private static func classify(_ error: Error) -> (AgentErrorCode, String) {
        if let e = error as? RecorderError { return (e.code, e.message) }
        let ns = error as NSError
        if ns.domain == SCStreamErrorDomain, ns.code == SCStreamError.userDeclined.rawValue {
            return (.permission, "Screen Recording permission is off. Allow Meeting Recorder in System Settings > Privacy & Security > Screen & System Audio Recording.")
        }
        return (.capture, ns.localizedDescription)
    }
}

enum RecorderError: Error {
    case capture(String), writer(String), permission(String)
    var code: AgentErrorCode {
        switch self { case .capture: return .capture; case .writer: return .writer; case .permission: return .permission }
    }
    var message: String {
        switch self { case .capture(let m), .writer(let m), .permission(let m): return m }
    }

    /// "The operation could not be completed" hides the cause: keep the domain/code (and the
    /// underlying error) so the log says exactly what failed.
    static func describe(_ error: Error?) -> String {
        guard let ns = error as NSError? else { return "unknown error" }
        var text = "\(ns.localizedDescription) [\(ns.domain) \(ns.code)]"
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            text += " caused by [\(underlying.domain) \(underlying.code)] \(underlying.localizedDescription)"
        }
        return text
    }
}

private func report(_ block: @escaping () -> Void) { DispatchQueue.main.async(execute: block) }
