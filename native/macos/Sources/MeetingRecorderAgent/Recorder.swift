// Screen + system audio + mic capture to a crash-safe fragmented MP4 (proven in spike/macos).
//
//   SCStream (one clock) ──┬── .screen      ─▶ FramePacer ─▶ H.264 (VideoToolbox), keyframe every 5 s ─┐
//                          ├── .audio       ─▶ AAC track "system"                                      ─┼─▶ AVAssetWriter
//                          └── .microphone  ─▶ AAC track "mic"                                         ─┘   fragment / 5 s
//
// Two separate audio tracks (no mixing): QuickTime plays both, and transcription can tell "You"
// (mic) from "Others" (system). The session starts on the first FRESH complete frame.
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
        let writer: AVAssetWriter
        let inputs: [AVAssetWriterInput]   // video, system, mic
        var stream: SCStream?
        var pacer: FramePacer
        var startPTS: CMTime?
        var lastPTS: CMTime = .invalid
        var finishing = false
        init(meetingId: String, writer: AVAssetWriter, inputs: [AVAssetWriterInput], fps: Int) {
            self.meetingId = meetingId
            self.writer = writer
            self.inputs = inputs
            self.pacer = FramePacer(fps: fps)
        }
    }

    /// The meeting being recorded right now (frames flowing), for hello after a daemon restart.
    var activeMeetingId: String? { queue.sync { session?.startPTS != nil ? session?.meetingId : nil } }
    var isBusy: Bool { queue.sync { session != nil || preparing != nil } }

    func start(meetingId: String, path: String, height: Int, fps: Int) {
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
                let writer = try Self.makeWriter(path: path, width: width, height: height, fps: fps)
                let s = Session(meetingId: meetingId, writer: writer.writer, inputs: writer.inputs, fps: fps)

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

                let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                let stream = SCStream(filter: filter, configuration: config, delegate: self)
                for type in [SCStreamOutputType.screen, .audio, .microphone] {
                    try stream.addStreamOutput(self, type: type, sampleHandlerQueue: queue)
                }
                s.stream = stream
                try await stream.startCapture()
                let stopRequested: Bool = queue.sync {
                    let requested = self.preparing?.stopRequested ?? false
                    self.preparing = nil
                    self.session = s
                    return requested
                }
                Log.info("capture started for \(meetingId) at \(width)x\(height)@\(fps)")
                if stopRequested { queue.async { self.finish(s, error: nil) } } // stop arrived during setup
            } catch {
                queue.sync { self.preparing = nil; self.session = nil }
                try? FileManager.default.removeItem(atPath: path)
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
        let pts = buffer.presentationTimeStamp
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
            let age = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pts).seconds
            guard age < CaptureMath.maxFirstFrameAgeSeconds else { return } // stale cached frame
            guard s.writer.startWriting() else { return finish(s, error: .writer(RecorderError.describe(s.writer.error))) }
            s.writer.startSession(atSourceTime: pts)
            s.startPTS = pts
            let id = s.meetingId
            report { self.onStarted?(id) }
        }
        guard let start = s.startPTS, pts >= start else { return }
        if index == 0, !s.pacer.accept(pts) { return }

        let input = s.inputs[index]
        if input.isReadyForMoreMediaData, input.append(buffer) {
            if index == 0 || CMTimeCompare(pts, s.lastPTS) > 0 { s.lastPTS = pts }
        } else if s.writer.status == .failed {
            finish(s, error: .writer(RecorderError.describe(s.writer.error)))
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
            let ok: Bool = await withCheckedContinuation { done in
                self.queue.async {
                    guard s.writer.status == .writing else { s.writer.cancelWriting(); return done.resume(returning: false) }
                    s.inputs.forEach { $0.markAsFinished() }
                    s.writer.finishWriting { done.resume(returning: s.writer.status == .completed) }
                }
            }
            // Stopped before the first frame: nothing was recorded. Not an error: remove the empty
            // file and report a 0 s stop (the daemon then removes the empty meeting).
            let neverStarted = s.startPTS == nil && error == nil
            if neverStarted { try? FileManager.default.removeItem(at: s.writer.outputURL) }
            let outcome: (Double?, RecorderError?) = {
                if let error { return (nil, error) }
                if ok || neverStarted { return (neverStarted ? 0 : max(0, duration), nil) }
                return (nil, .writer(RecorderError.describe(s.writer.error)))
            }()
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

    private static func makeWriter(path: String, width: Int, height: Int, fps: Int) throws -> (writer: AVAssetWriter, inputs: [AVAssetWriterInput]) {
        let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .mp4)
        writer.movieFragmentInterval = CMTime(seconds: CaptureMath.fragmentSeconds, preferredTimescale: 600)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
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
        // Speech accuracy depends on the source: 160 kbps for everyone else (stereo), 96 kbps for your mic.
        func aac(_ channels: Int) -> [String: Any] {
            [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: channels,
             AVEncoderBitRateKey: channels == 2 ? 160_000 : 96_000]
        }
        let inputs = [video, AVAssetWriterInput(mediaType: .audio, outputSettings: aac(2)), AVAssetWriterInput(mediaType: .audio, outputSettings: aac(1))]
        for input in inputs {
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw RecorderError.writer("Couldn't configure the recording file.") }
            writer.add(input)
        }
        return (writer, inputs)
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
