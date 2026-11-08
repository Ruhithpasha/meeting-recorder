// Gives captured audio a clean, continuous timeline before it reaches the file writer.
//
// ScreenCaptureKit stamps each audio buffer with the time it arrived, which jitters: buffers can
// overlap or leave tiny gaps. The writer's AAC encoder wants one continuous stream, and the
// microphone track failing mid-meeting (AVFoundation -11800 / -16341) is consistent with it not
// getting one. So each buffer is placed right after the previous one, by sample count:
//
//   time = anchor + samples written so far / sample rate
//   drift (arrival time - that time) within ±100 ms: keep the continuous time
//   arrived > 100 ms late (a real gap: the device paused): start again at the arrival time
//   arrived > 100 ms early (our timeline ran ahead of real time): drop this buffer to catch up
import CoreMedia

public struct AudioTimeline: Sendable {
    public static let maxDriftSeconds = 0.1
    private var anchor: CMTime?
    private var frames: Int64 = 0

    public init() {}

    /// The presentation time to use for a buffer of `count` samples at `rate` Hz that arrived
    /// stamped `arrival`, or nil to drop it.
    public mutating func place(arrival: CMTime, count: Int, rate: Double) -> CMTime? {
        guard count > 0, rate > 0, arrival.isNumeric else { return nil }
        let timescale = CMTimeScale(rate.rounded())
        if let anchor {
            let expected = CMTimeAdd(anchor, CMTime(value: frames, timescale: timescale))
            let drift = CMTimeSubtract(arrival, expected).seconds
            if drift < -Self.maxDriftSeconds { return nil }
            if drift <= Self.maxDriftSeconds {
                frames += Int64(count)
                return expected
            }
        }
        anchor = arrival
        frames = Int64(count)
        return arrival
    }
}
