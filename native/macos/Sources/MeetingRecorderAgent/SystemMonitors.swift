// Permissions (Screen Recording, Microphone) and power (sleep/wake, AC/battery).
import AgentCore
import AppKit
import AVFoundation
import IOKit.ps

/// macOS 15+ periodically asks users to re-confirm Screen Recording. We check hourly, at launch and
/// on wake, so a lapsed permission shows in the menu bar BEFORE the next meeting is missed.
final class Permissions {
    var onScreenChange: ((PermissionState) -> Void)?
    private var timer: Timer?

    func start() {
        // Ask once at launch (shows the system prompt only the first time).
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { granted in Log.info("microphone access \(granted ? "granted" : "denied")") }
        }
        check()
        timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in self?.check() }
    }

    func check() {
        onScreenChange?(CGPreflightScreenCaptureAccess() ? .granted : .denied)
    }

    static func openScreenRecordingSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }
}

final class PowerMonitor {
    var onChange: ((PowerState) -> Void)?
    private var lastSource: PowerState?
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []

    func start() {
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            self?.onChange?(.suspend)
        })
        observers.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.onChange?(.resume)
            self?.pollSource(force: true)
        })
        pollSource(force: true)
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.pollSource(force: false) }
    }

    /// Current power source, re-sent to a restarted daemon.
    var current: PowerState { lastSource ?? .ac }

    private func pollSource(force: Bool) {
        let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue()
        let type = info.flatMap { IOPSGetProvidingPowerSourceType($0)?.takeUnretainedValue() as String? }
        let source: PowerState = type == kIOPSBatteryPowerValue ? .battery : .ac
        guard force || source != lastSource else { return }
        lastSource = source
        onChange?(source)
    }
}
