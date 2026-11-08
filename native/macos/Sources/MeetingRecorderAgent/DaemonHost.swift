// Spawns and supervises the Node daemon. We are its parent, so macOS attributes permissions to
// "Meeting Recorder", and the daemon exits as soon as our end of its stdin closes.
//
//   this agent ──stdin──▶ node daemon     (AgentEvent lines)
//   this agent ◀─stdout── node daemon     (DaemonCommand lines, validated before use)
//              ◀─stderr── node daemon     → logs/daemon.stderr.log
//
// Crash → restart with exponential backoff (1 s … 30 s), reset after a healthy minute.
import AgentCore
import Foundation

final class DaemonHost {
    var onCommand: ((DaemonCommand) -> Void)?
    var onStarted: (() -> Void)?
    var onFatal: ((String) -> Void)?

    private let config: AgentConfig
    private let transcriberPath: String?
    private let validator: CommandValidator
    private let writeQueue = DispatchQueue(label: "daemon.stdin")
    private var process: Process?
    private var stdin: FileHandle?
    private var lines = LineBuffer()
    private var backoff = Backoff()
    private var startedAt = Date()
    private var stopping = false

    init(config: AgentConfig, transcriberPath: String?) {
        self.config = config
        self.transcriberPath = transcriberPath
        self.validator = CommandValidator(meetingsDir: config.meetingsDir)
    }

    func start() {
        stopping = false
        launch()
    }

    /// Closing stdin is the shutdown signal; the daemon exits on its own (hard deadline 5 s).
    func stop() {
        stopping = true
        writeQueue.sync { try? stdin?.close() }
        if let p = process, p.isRunning {
            let deadline = Date().addingTimeInterval(6)
            while p.isRunning, Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
            if p.isRunning { p.terminate() }
        }
    }

    func send(_ line: String) {
        writeQueue.async { [weak self] in
            guard let handle = self?.stdin else { return }
            do { try handle.write(contentsOf: Data(line.utf8)) } catch { Log.warn("daemon stdin write failed: \(error)") }
        }
    }

    private func launch() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: config.nodePath)
        p.arguments = [config.daemonEntry]
        var environment = [
            "MR_HOME": config.home,
            "MR_MEETINGS_DIR": config.meetingsDir,
            "MR_WEB_DIST": config.webDist,
            "HOME": NSHomeDirectory(),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "NODE_ENV": "production",
        ]
        if let transcriberPath { environment["MR_TRANSCRIBER"] = transcriberPath }
        p.environment = environment
        let input = Pipe(), output = Pipe()
        p.standardInput = input
        p.standardOutput = output
        p.standardError = Self.stderrLog(home: config.home)

        lines = LineBuffer()
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard let self, !chunk.isEmpty else { handle.readabilityHandler = nil; return }
            for line in self.lines.append(chunk) {
                switch self.validator.decode(line) {
                case .success(let command): DispatchQueue.main.async { self.onCommand?(command) }
                case .failure(let error): Log.warn("rejected daemon command: \(error)")
                }
            }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.handleExit(proc) }
        }

        do {
            try p.run()
        } catch {
            Log.warn("couldn't start daemon: \(error)")
            onFatal?("Couldn't start the recorder service. Run: meeting-recorder repair")
            return scheduleRestart()
        }
        process = p
        writeQueue.sync { stdin = input.fileHandleForWriting }
        startedAt = Date()
        Log.info("daemon started, pid \(p.processIdentifier)")
        onStarted?()
    }

    private func handleExit(_ proc: Process) {
        writeQueue.sync { stdin = nil }
        process = nil
        guard !stopping else { return }
        Log.warn("daemon exited (status \(proc.terminationStatus)); restarting")
        if Date().timeIntervalSince(startedAt) > 60 { backoff.reset() }
        scheduleRestart()
    }

    private func scheduleRestart() {
        guard !stopping else { return }
        let delay = backoff.next()
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopping, self.process == nil else { return }
            self.launch()
        }
    }

    private static func stderrLog(home: String) -> FileHandle {
        let path = (home as NSString).appendingPathComponent("logs/daemon.stderr.log")
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        let handle = FileHandle(forWritingAtPath: path) ?? FileHandle.nullDevice
        handle.seekToEndOfFile()
        return handle
    }
}
