// The menu-bar icon: always visible, red while recording (consent: never record silently).
import AgentCore
import AppKit

final class StatusMenu: NSObject {
    var onToggle: (() -> Void)?
    var onOpenDashboard: (() -> Void)?
    var onOpenFolder: (() -> Void)?
    var onOpenPermissions: (() -> Void)?
    var onQuit: (() -> Void)?

    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let stateLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private let toggle = NSMenuItem(title: "Start Recording", action: #selector(toggleClicked), keyEquivalent: "r")
    private let permissions = NSMenuItem(title: "Allow Screen Recording…", action: #selector(permissionsClicked), keyEquivalent: "")
    private var status: AgentStatus = .idle
    private var animation: Timer?
    private var frame = 0

    override init() {
        super.init()
        let menu = NSMenu()
        stateLine.isEnabled = false
        menu.addItem(stateLine)
        menu.addItem(.separator())
        for entry in [toggle,
                      NSMenuItem(title: "Open Dashboard", action: #selector(dashboardClicked), keyEquivalent: "d"),
                      NSMenuItem(title: "Open Meetings Folder", action: #selector(folderClicked), keyEquivalent: "")] {
            entry.target = self
            menu.addItem(entry)
        }
        permissions.target = self
        permissions.isHidden = true
        menu.addItem(permissions)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Meeting Recorder", action: #selector(quitClicked), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        render(status: .idle, label: nil)
    }

    func render(status: AgentStatus, label: String?) {
        self.status = status
        let text: String = {
            switch status {
            case .idle: return "Not recording"
            case .starting: return "Starting recording…"
            case .recording: return label ?? "Recording"
            case .stopping: return "Saving recording…"
            case .warning: return label ?? "Needs attention"
            }
        }()
        animation?.invalidate()
        animation = nil
        switch status {
        case .idle:
            item.button?.image = Self.waveform(Self.restingLevels, color: nil)
        case .recording:
            // A gently moving waveform: the live signal. ~6 fps, a few CPU microseconds per frame.
            frame = 0
            item.button?.image = Self.waveform(Self.liveFrames[0], color: .systemRed)
            animation = Timer.scheduledTimer(withTimeInterval: 0.16, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.frame = (self.frame + 1) % Self.liveFrames.count
                self.item.button?.image = Self.waveform(Self.liveFrames[self.frame], color: .systemRed)
            }
        case .starting, .stopping:
            item.button?.image = Self.waveform(Self.restingLevels, color: .systemRed)
        case .warning:
            let image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: text)?
                .withSymbolConfiguration(.init(paletteColors: [.systemOrange]))
            image?.isTemplate = false
            item.button?.image = image
        }
        item.button?.image?.accessibilityDescription = text
        item.button?.toolTip = "Meeting Recorder: \(text)"
        stateLine.title = text
        toggle.title = status == .recording || status == .starting ? "Stop Recording" : "Start Recording"
        toggle.isEnabled = status != .stopping
    }

    // MARK: Waveform icon (matches the app icon)

    private static let restingLevels: [CGFloat] = [0.35, 0.6, 0.9, 0.6, 0.35]
    private static let liveFrames: [[CGFloat]] = [
        [0.35, 0.6, 0.9, 0.6, 0.35], [0.5, 0.85, 0.6, 0.75, 0.3], [0.3, 0.7, 1.0, 0.45, 0.55],
        [0.6, 0.4, 0.75, 0.9, 0.4], [0.4, 0.9, 0.5, 0.65, 0.6], [0.55, 0.5, 0.85, 0.4, 0.3],
    ]

    /// 18×18 pt menu-bar image: five rounded bars. Template (adapts to light/dark menu bars) when
    /// `color` is nil; tinted otherwise.
    static func waveform(_ levels: [CGFloat], color: NSColor?) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            let barW: CGFloat = 2.2, gap: CGFloat = 1.3
            let total = CGFloat(levels.count) * barW + CGFloat(levels.count - 1) * gap
            var x = rect.midX - total / 2
            (color ?? .black).setFill()
            for level in levels {
                let h = max(barW, rect.height * 0.78 * level)
                NSBezierPath(roundedRect: NSRect(x: x, y: rect.midY - h / 2, width: barW, height: h), xRadius: barW / 2, yRadius: barW / 2).fill()
                x += barW + gap
            }
            return true
        }
        image.isTemplate = color == nil
        return image
    }

    func setPermissionMissing(_ missing: Bool) {
        permissions.isHidden = !missing
    }

    func showError(_ message: String) {
        render(status: .warning, label: message)
    }

    @objc private func toggleClicked() { onToggle?() }
    @objc private func dashboardClicked() { onOpenDashboard?() }
    @objc private func folderClicked() { onOpenFolder?() }
    @objc private func permissionsClicked() { onOpenPermissions?() }
    @objc private func quitClicked() { onQuit?() }
}
