// A small floating "REC 12:34" pill while recording, so it's always obvious that a meeting is
// being recorded, even when the menu-bar icon is hidden behind the notch. It floats above other
// windows on every Space (and over full-screen apps), can be dragged anywhere, and a click opens
// the dashboard. It is not in the recording: our own windows are excluded from capture.
import AgentCore
import AppKit

final class RecordingIndicator {
    var onClick: (() -> Void)?

    private var panel: NSPanel?
    private let label = NSTextField(labelWithString: "")
    private let dot = NSView()
    private var timer: Timer?
    private var since = Date()

    func show(since start: Date) {
        if panel == nil { create() }
        since = start
        tick()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        panel?.orderFrontRegardless()
        pulse()
    }

    func hide() {
        timer?.invalidate()
        timer = nil
        panel?.orderOut(nil)
    }

    private func tick() {
        label.stringValue = "REC " + Elapsed.format(Int(Date().timeIntervalSince(since)))
    }

    private func pulse() {
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = 1
        animation.toValue = 0.35
        animation.duration = 0.9
        animation.autoreverses = true
        animation.repeatCount = .infinity
        dot.layer?.add(animation, forKey: "pulse")
    }

    private func create() {
        let size = NSSize(width: 112, height: 30)
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.hidesOnDeactivate = false

        let background = ClickView(frame: NSRect(origin: .zero, size: size))
        background.onClick = { [weak self] in self?.onClick?() }
        background.wantsLayer = true
        background.layer?.backgroundColor = NSColor(white: 0.08, alpha: 0.88).cgColor
        background.layer?.cornerRadius = size.height / 2
        background.toolTip = "Meeting Recorder is recording. Click to open the dashboard; drag to move."
        background.setAccessibilityLabel("Meeting Recorder is recording")

        dot.frame = NSRect(x: 12, y: (size.height - 10) / 2, width: 10, height: 10)
        dot.wantsLayer = true
        dot.layer?.backgroundColor = NSColor.systemRed.cgColor
        dot.layer?.cornerRadius = 5
        label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        label.textColor = .white
        label.frame = NSRect(x: 28, y: (size.height - 16) / 2, width: size.width - 34, height: 16)
        background.addSubview(dot)
        background.addSubview(label)
        panel.contentView = background

        // Top-right corner, just below the menu bar.
        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: screen.maxX - size.width - 16, y: screen.maxY - size.height - 10))
        }
        self.panel = panel
    }
}

/// Click without drag opens the dashboard; a drag moves the pill.
private final class ClickView: NSView {
    var onClick: (() -> Void)?
    private var downAt: NSPoint?
    override func mouseDown(with event: NSEvent) { downAt = event.locationInWindow; super.mouseDown(with: event) }
    override func mouseUp(with event: NSEvent) {
        if let downAt, hypot(event.locationInWindow.x - downAt.x, event.locationInWindow.y - downAt.y) < 3 { onClick?() }
        super.mouseUp(with: event)
    }
}
