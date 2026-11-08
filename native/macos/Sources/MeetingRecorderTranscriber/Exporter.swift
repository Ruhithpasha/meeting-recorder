// Makes share.mp4: a smaller copy that plays the same everywhere.
//   recording.mp4 (video + two audio tracks: others, you)
//     ─▶ AVAssetReader (video frames, and both audio tracks MIXED into one)
//     ─▶ AVAssetWriter: H.264 at most 1280x720 (Apple's hardware encoder), AAC 128 kbps stereo
//   Most players only play the first audio track, so the original would sound one-sided when
//   shared; the copy has everyone in one track. ~0.6 GB per hour instead of ~2 GB.
// Written to share.mp4.part, renamed when complete. Progress: {"percent":n}.
import AVFoundation
import Foundation

enum Exporter {
    static func run(input: URL, output: URL) async throws {
        let asset = AVURLAsset(url: input)
        guard let video = try await asset.loadTracks(withMediaType: .video).first else { throw ModelError("The recording has no video.") }
        let audio = try await asset.loadTracks(withMediaType: .audio)
        let duration = try await asset.load(.duration).seconds
        let natural = try await video.load(.naturalSize)
        // Fit inside 1280x720, keep the aspect ratio, even dimensions (encoder requirement).
        let scale = min(1, 1280 / max(natural.width, 1), 720 / max(natural.height, 1))
        let width = Int(natural.width * scale) & ~1, height = Int(natural.height * scale) & ~1

        let reader = try AVAssetReader(asset: asset)
        let videoOut = AVAssetReaderTrackOutput(track: video, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
        videoOut.alwaysCopiesSampleData = false
        reader.add(videoOut)
        let audioOut = audio.isEmpty ? nil : AVAssetReaderAudioMixOutput(audioTracks: audio, audioSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
        ])
        if let audioOut { reader.add(audioOut) }

        let partial = output.appendingPathExtension("part")
        try? FileManager.default.removeItem(at: partial)
        let writer = try AVAssetWriter(outputURL: partial, fileType: .mp4)
        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoScalingModeKey: AVVideoScalingModeResizeAspect,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 1_200_000, AVVideoMaxKeyFrameIntervalDurationKey: 4],
        ])
        videoIn.expectsMediaDataInRealTime = false
        writer.add(videoIn)
        let audioIn = audioOut == nil ? nil : AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 128_000,
        ])
        if let audioIn { writer.add(audioIn) }

        guard reader.startReading() else { throw reader.error ?? ModelError("Couldn't read the recording.") }
        guard writer.startWriting() else { throw writer.error ?? ModelError("Couldn't write the copy.") }
        writer.startSession(atSourceTime: .zero)

        // Feed each track until it runs dry. If the writer fails (disk full, encoder error) both
        // loops see it and stop, so nothing waits forever.
        let progress = ProgressReporter(duration: duration)
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await pump(videoOut, into: videoIn, writer: writer, progress: progress) }
            if let audioOut, let audioIn { group.addTask { await pump(audioOut, into: audioIn, writer: writer, progress: nil) } }
        }
        if writer.status == .failed { reader.cancelReading(); throw writer.error ?? ModelError("Writing the copy failed.") }
        if reader.status == .failed { writer.cancelWriting(); throw reader.error ?? ModelError("Reading the recording failed.") }
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? ModelError("Writing the copy failed.") }
        try? FileManager.default.removeItem(at: output)
        try FileManager.default.moveItem(at: partial, to: output)
    }

    private static func pump(_ output: AVAssetReaderOutput, into input: AVAssetWriterInput, writer: AVAssetWriter, progress: ProgressReporter?) async {
        while writer.status == .writing {
            guard input.isReadyForMoreMediaData else {
                try? await Task.sleep(for: .milliseconds(10)) // the encoder is busy: wait a moment
                continue
            }
            guard let sample = output.copyNextSampleBuffer() else { return input.markAsFinished() }
            progress?.report(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
            if !input.append(sample) { return } // writer failed: the other loop stops too
        }
    }
}

final class ProgressReporter: @unchecked Sendable {
    private let duration: Double
    private var last = -1
    init(duration: Double) { self.duration = duration }
    func report(_ seconds: Double) {
        guard duration > 0 else { return }
        let percent = min(99, Int(seconds / duration * 100))
        if percent >= last + 2 { last = percent; emit(["percent": percent]) }
    }
}
