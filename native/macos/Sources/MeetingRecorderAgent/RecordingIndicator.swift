// A small floating pill, so you always know (and decide) whether a meeting is being recorded:
//
//   asking     "Google Meet detected   ● Record"    automatic recording off (the default): nothing
//                                                   records until you press Record
//   recording  "● REC 12:34   ■ Stop"               shown the whole time a recording runs
//
// Visible even when the menu-bar icon is hidden behind the notch. It floats above other windows
// on every desktop Space, but not over full-screen apps (it would cover them; the menu-bar timer
// still shows there). Drag it anywhere; a click on the text opens the dashboard. It is not in the
// recording: our own windows are excluded from capture.
import AgentCore
import AppKit

final class RecordingIndicator {
    var onClick: (() -> Void)?
    var onRecord: (() -> Void)?
    var onStop: (() -> Void)?

    private var panel: NSPanel?
    private let label = NSTextField(labelWithString: "")
    private let dot = NSView()
    private let button = NSButton(title: "", target: nil, action: nil)
    private var timer: Timer?
    private var since = Date()
    private var recording = false
    private var asking = false

    /// Recording started: the REC timer and a Stop button.
    func show(since start: Date) {
        recording = true
        asking = false
        since = start
        layout(text: "REC " + Elapsed.format(0), buttonTitle: "Stop", buttonSymbol: "stop.fill", width: 168)
        tick()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        pulse(true)
    }

    /// Recording ended: the pill goes. (After a Stop mid-meeting the daemon doesn't ask again until
    /// that meeting ends, so no prompt comes back.)
    func hide() {
        recording = false
        timer?.invalidate()
        timer = nil
        panel?.orderOut(nil)
    }

    /// A meeting was detected and automatic recording is off: offer to record it.
    func ask(label meeting: String) {
        guard !recording else { return }
        asking = true
        layout(text: "\(meeting) detected", buttonTitle: "Record", buttonSymbol: "record.circle", width: 250)
        pulse(false)
    }

    func hidePrompt() {
        guard asking, !recording else { return }
        asking = false
        panel?.orderOut(nil)
    }

    private func tick() {
        label.stringValue = "REC " + Elapsed.format(Int(Date().timeIntervalSince(since)))
    }

    private func pulse(_ on: Bool) {
        dot.layer?.removeAnimation(forKey: "pulse")
        dot.layer?.backgroundColor = (on ? NSColor.systemRed : NSColor.systemGray).cgColor
        guard on, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let animation = CABasicAnimation(keyPath: "opacity")
        animation.fromValue = 1
        animation.toValue = 0.35
        animation.duration = 0.9
        animation.autoreverses = true
        animation.repeatCount = .infinity
        dot.layer?.add(animation, forKey: "pulse")
    }

    private func layout(text: String, buttonTitle: String, buttonSymbol: String, width minimum: CGFloat) {
        if panel == nil { create() }
        guard let panel, let content = panel.contentView else { return }
        let height: CGFloat = 32
        // Wide enough for the text: the longest time ("REC 10:00:00") or the app name, never cut off.
        let sample = recording ? "REC 10:00:00" : text
        let textWidth = ceil((sample as NSString).size(withAttributes: [.font: label.font ?? NSFont.systemFont(ofSize: 12)]).width)
        let width = max(minimum, 28 + textWidth + 12 + 80)
        var frame = panel.frame
        frame.origin.x += frame.width - width // keep the right edge where it was
        frame.size = NSSize(width: width, height: height)
        panel.setFrame(frame, display: true)
        content.frame = NSRect(origin: .zero, size: frame.size)
        label.stringValue = text
        label.frame = NSRect(x: 28, y: (height - 16) / 2, width: width - 28 - 88, height: 16)
        button.title = buttonTitle
        button.image = NSImage(systemSymbolName: buttonSymbol, accessibilityDescription: buttonTitle)
        button.frame = NSRect(x: width - 80, y: (height - 22) / 2, width: 72, height: 22)
        content.setAccessibilityLabel(asking ? "Meeting detected. Record it?" : "Meeting Recorder is recording")
        panel.orderFrontRegardless()
    }

    @objc private func buttonPressed() {
        if recording { onStop?() } else { onRecord?() }
    }

    private func create() {
        let size = NSSize(width: 168, height: 32)
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle] // not .fullScreenAuxiliary
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.hidesOnDeactivate = false

        let background = ClickView(frame: NSRect(origin: .zero, size: size))
        background.onClick = { [weak self] in self?.onClick?() }
        background.wantsLayer = true
        background.layer?.backgroundColor = NSColor(white: 0.08, alpha: 0.9).cgColor
        background.layer?.cornerRadius = size.height / 2
        background.toolTip = "Click to open the dashboard; drag to move."

        dot.frame = NSRect(x: 12, y: (size.height - 10) / 2, width: 10, height: 10)
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 5
        label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        label.textColor = .white
        label.lineBreakMode = .byTruncatingTail
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.imagePosition = .imageLeading
        button.target = self
        button.action = #selector(buttonPressed)
        background.addSubview(dot)
        background.addSubview(label)
        background.addSubview(button)
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
