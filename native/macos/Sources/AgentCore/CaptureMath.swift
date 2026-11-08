// Capture rules proven in the T1 spike (spike/README.md), kept pure so they can be checked.
import CoreMedia
import Foundation

public enum CaptureMath {
    /// Width that keeps the display's aspect ratio at `height`, rounded to even (H.264 requirement).
    public static func evenWidth(displayWidth: Int, displayHeight: Int, height: Int) -> Int {
        precondition(displayWidth > 0 && displayHeight > 0 && height > 0)
        return max(2, Int((Double(height) * Double(displayWidth) / Double(displayHeight) / 2).rounded()) * 2)
    }

    /// A first frame older than this is stale (cached from before capture began): don't start on it.
    public static let maxFirstFrameAgeSeconds = 0.5

    /// Fragment length, and the keyframe interval (time-based, so static screens still get keyframes).
    public static let fragmentSeconds = 5.0
}

/// Drops frames that arrive closer together than 90% of the target frame period.
/// ScreenCaptureKit does not always honor minimumFrameInterval (spike: ~48 fps for a 15 fps cap).
public struct FramePacer: Sendable {
    public let minSpacingSeconds: Double
    private var last: CMTime?

    public init(fps: Int) {
        minSpacingSeconds = 0.9 / Double(fps)
    }

    /// True if this frame should be encoded.
    public mutating func accept(_ pts: CMTime) -> Bool {
        if let last, CMTimeSubtract(pts, last).seconds < minSpacingSeconds { return false }
        last = pts
        return true
    }
}

/// The set of other apps using a mic, compared by value so unchanged snapshots aren't re-sent.
public struct MicSnapshot: Equatable, Sendable {
    public let users: [MicUser]
    public let windows: [WindowInfo]

    public init(users: [MicUser], windows: [WindowInfo]) {
        // Stable order: equal sets compare equal regardless of enumeration order.
        self.users = users.sorted { ($0.bundleId, $0.pid) < ($1.bundleId, $1.pid) }
        self.windows = windows.sorted { ($0.bundleId, $0.title) < ($1.bundleId, $1.title) }
    }

    public static let empty = MicSnapshot(users: [], windows: [])

    /// Window titles are only useful (and only sent) while some other app uses a mic.
    public static let maxWindows = 50
    public static func relevantWindows(_ windows: [WindowInfo], whenUsers users: [MicUser]) -> [WindowInfo] {
        guard !users.isEmpty else { return [] }
        return Array(windows.filter { !$0.title.isEmpty }.prefix(maxWindows))
            .map { WindowInfo(bundleId: $0.bundleId, title: String($0.title.prefix(300))) }
    }
}
