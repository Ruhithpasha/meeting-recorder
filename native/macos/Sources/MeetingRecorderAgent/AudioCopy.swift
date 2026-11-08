// Puts captured audio on its continuous timeline (AudioTimeline) for the writer, copying a buffer
// only when its time actually changes. Also logs the first buffer of each input once: the writer
// fails intermittently (-11800 / -16341, at a 5 s fragment boundary), and ScreenCaptureKit's mic
// buffers differ from the system audio's (they carry a sample-size table), so that's on record.
import AVFoundation

final class AudioCopy {
    private var describedOnce = false

    /// `buffer` stamped `pts` (the same buffer when the time is unchanged), or nil if unusable.
    func placed(_ buffer: CMSampleBuffer, at pts: CMTime, rate: Double, label: String) -> CMSampleBuffer? {
        if !describedOnce { describedOnce = true; Log.info("\(label) audio: " + Self.describe(buffer)) }
        if pts == buffer.presentationTimeStamp { return buffer }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(rate.rounded())), presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var copy: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: nil, sampleBuffer: buffer, sampleTimingEntryCount: 1,
                                                    sampleTimingArray: &timing, sampleBufferOut: &copy) == noErr else { return nil }
        return copy
    }

    private static func describe(_ buffer: CMSampleBuffer) -> String {
        guard let asbd = buffer.formatDescription.flatMap({ CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }) else { return "not PCM" }
        var timingCount: CMItemCount = 0
        CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &timingCount)
        var sizeCount: CMItemCount = 0
        CMSampleBufferGetSampleSizeArray(buffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &sizeCount)
        let attachments = (CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[String: Any]])?.first?.keys.sorted() ?? []
        let bytes = CMSampleBufferGetDataBuffer(buffer).map { CMBlockBufferGetDataLength($0) } ?? 0
        return "\(Int(asbd.mSampleRate)) Hz, \(asbd.mChannelsPerFrame) ch, flags \(asbd.mFormatFlags), \(asbd.mBitsPerChannel) bit, " +
            "\(CMSampleBufferGetNumSamples(buffer)) samples, duration \(CMSampleBufferGetDuration(buffer).seconds), " +
            "\(timingCount) timing entries, \(sizeCount) size entries, \(bytes) data bytes, attachments \(attachments)"
    }
}
