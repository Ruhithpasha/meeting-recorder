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
        let (symbol, tint, text): (String, NSColor?, String) = {
            switch status {
            case .idle: return ("record.circle", nil, "Not recording")
            case .starting: return ("record.circle", .systemRed, "Starting recording…")
            case .recording: return ("record.circle.fill", .systemRed, label ?? "Recording")
            case .stopping: return ("record.circle", .systemRed, "Saving recording…")
            case .warning: return ("exclamationmark.triangle", .systemOrange, label ?? "Needs attention")
            }
        }()
        var image = NSImage(systemSymbolName: symbol, accessibilityDescription: text)
        if let tint, let base = image {
            image = base.withSymbolConfiguration(.init(paletteColors: [tint]))
            image?.isTemplate = false
        } else {
            image?.isTemplate = true
        }
        item.button?.image = image
        item.button?.toolTip = "Meeting Recorder: \(text)"
        stateLine.title = text
        toggle.title = status == .recording || status == .starting ? "Stop Recording" : "Start Recording"
        toggle.isEnabled = status != .stopping
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
