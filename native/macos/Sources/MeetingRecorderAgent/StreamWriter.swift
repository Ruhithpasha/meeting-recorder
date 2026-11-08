// One stream of a recording (video, system audio or microphone), written to its own crash-safe
// fragmented MP4 part. If the writer fails, this stream alone starts its next part (after a short
// pause, so a hiccup can't burn through its retries); the other streams never notice.
// Used only on the recorder's capture queue, including finish().
import AgentCore
import AVFoundation

final class StreamWriter {
    let stream: String                     // "video", "system", "mic"
    private let directory: URL
    private let makeInput: () -> AVAssetWriterInput
    /// Records a new part in parts.json; false if it couldn't be saved (the part is then not used,
    /// so the merge never misses a part that was written).
    private let onPart: (PartsManifest.Part) -> Bool
    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var partNumber = 0
    private var failures: [Date] = []
    private var retryAfter = Date.distantPast
    private(set) var gaveUp = false

    // For the diagnostics line.
    private(set) var appended = 0
    private(set) var lastAppended: CMTime = .invalid
    var dropped = 0

    /// Failures allowed per stream per minute before it stops trying (the others go on).
    static let maxFailuresPerMinute = 5
    static let retryDelay: TimeInterval = 1

    init(stream: String, directory: URL, makeInput: @escaping () -> AVAssetWriterInput, onPart: @escaping (PartsManifest.Part) -> Bool) {
        self.stream = stream
        self.directory = directory
        self.makeInput = makeInput
        self.onPart = onPart
    }

    /// Appends one sample stamped `pts`; `start` is the recording's start. Opens a part if needed.
    /// Returns true when the sample was written.
    @discardableResult
    func append(_ sample: CMSampleBuffer, at pts: CMTime, start: CMTime, meetingId: String) -> Bool {
        guard !gaveUp else { return false }
        if lastAppended.isValid, CMTimeCompare(pts, lastAppended) <= 0 { dropped += 1; return false }
        if writer == nil {
            guard Date() >= retryAfter else { dropped += 1; return false } // pausing after a failure
            guard openPart(at: pts, start: start, meetingId: meetingId) else { return false }
        }
        guard let writer, let input else { return false }
        if input.isReadyForMoreMediaData, input.append(sample) {
            appended += 1
            lastAppended = pts
            return true
        }
        if writer.status == .failed { failed(meetingId: meetingId, step: "append", start: start) }
        return false
    }

    /// Starts finishing the current part; `done` runs when it's finished. A part that can't finish
    /// keeps its saved fragments.
    func finish(_ done: @escaping () -> Void) {
        guard let writer, let input, writer.status == .writing else { return done() }
        input.markAsFinished()
        let stream = stream, part = partNumber
        writer.finishWriting {
            if writer.status != .completed { Log.warn("\(stream) part \(part) didn't finish cleanly: \(RecorderError.describe(writer.error)); its saved fragments are kept") }
            done()
        }
    }

    /// The part files this stream wrote (to remove them if the recording never started).
    var files: [URL] { (0..<partNumber).map { directory.appendingPathComponent("\(stream)-\($0 + 1).mp4") } }

    func diagnostics(start: CMTime) -> String {
        let last = lastAppended.isValid ? String(format: "%.2fs", CMTimeSubtract(lastAppended, start).seconds) : "-"
        return "\(stream): part \(partNumber), \(appended) samples, last \(last), \(dropped) dropped"
    }

    private func openPart(at pts: CMTime, start: CMTime, meetingId: String) -> Bool {
        partNumber += 1
        let file = "\(stream)-\(partNumber).mp4"
        do {
            let writer = try AVAssetWriter(outputURL: directory.appendingPathComponent(file), fileType: .mp4)
            writer.movieFragmentInterval = CMTime(seconds: CaptureMath.fragmentSeconds, preferredTimescale: 600)
            let input = makeInput()
            input.expectsMediaDataInRealTime = true
            guard writer.canAdd(input) else { throw RecorderError.writer("Couldn't configure the \(stream) file.") }
            writer.add(input)
            // Listed in parts.json before anything is written to it.
            guard onPart(.init(stream: stream, file: file, start: max(0, CMTimeSubtract(pts, start).seconds))) else {
                throw RecorderError.writer("parts.json couldn't be saved")
            }
            guard writer.startWriting() else { throw RecorderError.writer(RecorderError.describe(writer.error)) }
            writer.startSession(atSourceTime: pts)
            self.writer = writer
            self.input = input
            if partNumber > 1 { Log.info("recording \(meetingId): \(stream) continues in \(file)") }
            return true
        } catch {
            Log.warn("recording \(meetingId): couldn't open \(file): \(error)")
            noteFailure(meetingId: meetingId)
            return false
        }
    }

    private func failed(meetingId: String, step: String, start: CMTime) {
        Log.warn("recording \(meetingId): \(stream) writer failed during \(step): \(RecorderError.describe(writer?.error)); " + diagnostics(start: start))
        // Not cancelWriting(): that can delete the file. A failed writer is simply dropped; its part
        // keeps the fragments saved so far, and the daemon trims the unfinished tail before merging.
        writer = nil
        input = nil
        noteFailure(meetingId: meetingId)
    }

    private func noteFailure(meetingId: String) {
        let now = Date()
        retryAfter = now.addingTimeInterval(Self.retryDelay)
        failures = failures.filter { now.timeIntervalSince($0) < 60 } + [now]
        if failures.count > Self.maxFailuresPerMinute {
            gaveUp = true
            Log.warn("recording \(meetingId): \(stream) failed \(failures.count) times in a minute; this stream stops, the others continue")
        }
    }
}
