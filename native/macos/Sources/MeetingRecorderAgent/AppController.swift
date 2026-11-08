// Wires the agent together. The agent reports facts (mic users, capture results, power,
// permissions); the daemon decides (state machine, detection rules, storage).
import AgentCore
import AppKit
import UserNotifications

final class AppController: NSObject, NSApplicationDelegate {
    static let version = "0.1.0"

    private let menu = StatusMenu()
    private let recorder = Recorder()
    private let mic = MicMonitor()
    private let permissions = Permissions()
    private let power = PowerMonitor()
    private let dashboard = DashboardWindow()
    private let indicator = RecordingIndicator()
    private var meetingsDir = ""
    /// launchd starts us with --background at login: stay in the menu bar. Opened by the user
    /// (Finder, Spotlight, Launchpad, `meeting-recorder open`): show the dashboard window.
    private let launchedInBackground = CommandLine.arguments.contains("--background")
    private var daemon: DaemonHost?
    private var lastPermission: PermissionState = .granted
    private var quitting = false
    /// Set once a quit is decided (⌘Q / Dock / menu confirmed, logout/shutdown, SIGTERM).
    private var allowTermination = false
    private var sigterm: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN) // a dead daemon must not kill us through its closed stdin
        // launchctl bootout / logout send SIGTERM: terminate in order so an active recording is
        // finalized (applicationWillTerminate) instead of the process just dying.
        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { [weak self] in self?.allowTermination = true; NSApp.terminate(nil) }
        term.resume()
        sigterm = term
        guard isOnlyInstance() else { return NSApp.terminate(nil) }
        Log.open(home: AgentConfig.defaultHome())
        Log.info("agent \(Self.version) starting")

        menu.onToggle = { [weak self] in self?.send(EventEncoder.tray(.toggle)) }
        menu.onOpenDashboard = { [weak self] in self?.send(EventEncoder.tray(.openDashboard)) }
        menu.onOpenFolder = { [weak self] in self?.send(EventEncoder.tray(.openFolder)) }
        menu.onOpenPermissions = { Permissions.openScreenRecordingSettings() }
        menu.onQuit = { [weak self] in self?.userQuit() }
        MainMenu.install(target: self, quit: #selector(quitFromMenu), closeWindow: #selector(closeDashboard))
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main) { [weak self] _ in
            self?.allowTermination = true // logout, restart, shutdown
        }

        switch AgentConfig.load() {
        case .failure(let error):
            Log.warn("config: \(error)")
            menu.showError(error.description)
            return
        case .success(let config):
            start(with: config)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Never leave a file unfinished; report the result directly (main is blocked meanwhile).
        if recorder.isBusy, let result = recorder.stopAndWait(timeout: 8) {
            if let error = result.error {
                send(EventEncoder.recording(.error, meetingId: result.meetingId, error: AgentError(code: error.code, message: error.message)))
            } else {
                send(EventEncoder.recording(.stopped, meetingId: result.meetingId, durationSec: result.durationSec ?? 0))
            }
            Thread.sleep(forTimeInterval: 0.3) // let the daemon read it before stdin closes
        }
        daemon?.stop()
        Log.info("agent stopped")
    }

    private func start(with config: AgentConfig) {
        meetingsDir = config.meetingsDir
        let transcriber = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/MeetingRecorderTranscriber").path
        let host = DaemonHost(config: config, transcriberPath: FileManager.default.isExecutableFile(atPath: transcriber) ? transcriber : nil)
        daemon = host
        host.onStarted = { [weak self] in self?.sendHello() }
        host.onCommand = { [weak self] in self?.handle($0) }
        host.onFatal = { [weak self] in self?.menu.showError($0) }

        indicator.onClick = { [weak self] in self?.send(EventEncoder.tray(.openDashboard)) }
        recorder.onTranscript = { [weak self] id, s in
            self?.send(EventEncoder.transcript(meetingId: id, speaker: s.speaker == "You" ? .you : .others, start: s.start, end: s.end, text: s.text))
        }
        recorder.onStarted = { [weak self] id in
            let now = Date()
            self?.menu.recordingSince = now
            self?.indicator.show(since: now)
            self?.send(EventEncoder.recording(.started, meetingId: id))
            Self.notify(title: "Recording started", body: "Meeting Recorder is recording your screen and audio.")
        }
        recorder.onStopped = { [weak self] id, duration in
            self?.indicator.hide()
            self?.send(EventEncoder.recording(.stopped, meetingId: id, durationSec: duration))
        }
        recorder.onError = { [weak self] id, code, message in
            self?.indicator.hide()
            self?.send(EventEncoder.recording(.error, meetingId: id, error: AgentError(code: code, message: message)))
        }
        mic.onChange = { [weak self] snapshot in self?.send(EventEncoder.mic(users: snapshot.users, windows: snapshot.windows)) }
        permissions.onScreenChange = { [weak self] state in
            self?.lastPermission = state
            self?.menu.setPermissionMissing(state == .denied)
            self?.send(EventEncoder.permission(state))
        }
        power.onChange = { [weak self] state in
            if state == .resume { self?.permissions.check() }
            self?.send(EventEncoder.power(state))
        }

        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { _, _ in }
        host.start()
        permissions.start()
        power.start()
        mic.start()
        if !launchedInBackground { send(EventEncoder.tray(.openDashboard)) } // the daemon replies with openUrl
    }

    /// Double-clicking the app (or `open -a`) while it's already running: show the dashboard.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        send(EventEncoder.tray(.openDashboard))
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// ⌘Q and Dock → Quit quit, like any Mac app. A recording in progress is asked about first,
    /// then finished and saved before the app exits (quit() waits for the recorder).
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allowTermination { return .terminateNow }
        userQuit()
        return .terminateCancel // quit() terminates for real once the recording is saved
    }

    @objc private func quitFromMenu() { userQuit() }

    private func userQuit() {
        guard recorder.isBusy else { return quit() }
        NSApp.activate()
        let alert = NSAlert()
        alert.messageText = "A meeting is being recorded"
        alert.informativeText = "Quitting stops the recording and saves it. Meeting Recorder starts again the next time you log in, or when you open it."
        alert.addButton(withTitle: "Stop, Save and Quit")
        alert.addButton(withTitle: "Keep Recording")
        if alert.runModal() == .alertFirstButtonReturn { quit() }
    }
    @objc private func closeDashboard() { dashboard.close() }

    /// First line to every (re)started daemon, followed by the current facts it needs.
    private func sendHello() {
        send(EventEncoder.hello(agentVersion: Self.version, activeMeetingId: recorder.activeMeetingId))
        send(EventEncoder.permission(lastPermission))
        send(EventEncoder.power(power.current))
        mic.resend()
    }

    private func handle(_ command: DaemonCommand) {
        switch command {
        case .start(let c): recorder.start(meetingId: c.meetingId, path: c.path, height: c.height, fps: c.fps, liveLocale: c.liveLocale)
        case .stop(let c): recorder.stop(meetingId: c.meetingId)
        case .state(let c):
            menu.render(status: c.status, label: c.label)
            if quitting, c.status == .idle { NSApp.terminate(nil) }
        case .openUrl(let c):
            if let url = URL(string: c.url) { dashboard.show(url: url) } // in-app window, not a browser
        case .share(let c):
            // Path built here from the validated id and a fixed file name, never taken from the daemon.
            let file = URL(fileURLWithPath: meetingsDir).appendingPathComponent(c.meetingId).appendingPathComponent(c.file.rawValue)
            guard FileManager.default.fileExists(atPath: file.path) else { return Log.warn("share: \(c.file.rawValue) missing") }
            dashboard.share(file)
        }
    }

    private func send(_ line: String) {
        daemon?.send(line)
    }

    /// Quit finishes an active recording first: the daemon stops it and we exit on its idle state.
    private func quit() {
        allowTermination = true
        guard recorder.isBusy else { return NSApp.terminate(nil) }
        quitting = true
        send(EventEncoder.tray(.quit))
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { NSApp.terminate(nil) } // bounded
    }

    private func isOnlyInstance() -> Bool {
        guard let id = Bundle.main.bundleIdentifier else { return true }
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: id).filter { $0 != .current }
        return others.isEmpty
    }

    private static func notify(title: String, body: String) {
        guard Bundle.main.bundleIdentifier != nil else { return } // not running as an .app bundle
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}
