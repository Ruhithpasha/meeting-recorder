import Foundation

/// ~/.meeting-recorder/agent.json, written by the installer: where the pinned Node runtime and the
/// daemon live. The agent never searches PATH, so a brew/nvm Node upgrade can't break it.
public struct AgentConfig: Codable, Equatable, Sendable {
    public let nodePath: String
    public let daemonEntry: String
    public let webDist: String
    public let meetingsDir: String
    public let home: String

    public init(nodePath: String, daemonEntry: String, webDist: String, meetingsDir: String, home: String) {
        self.nodePath = nodePath
        self.daemonEntry = daemonEntry
        self.webDist = webDist
        self.meetingsDir = meetingsDir
        self.home = home
    }

    /// ~/.meeting-recorder, or MR_HOME when set (development and tests).
    public static func defaultHome() -> String {
        if let override = ProcessInfo.processInfo.environment["MR_HOME"], override.hasPrefix("/") { return override }
        return (NSHomeDirectory() as NSString).appendingPathComponent(".meeting-recorder")
    }

    public enum LoadError: Error, Equatable, CustomStringConvertible {
        case missing(String)
        case unreadable(String)
        case notExecutable(String)
        public var description: String {
            switch self {
            case .missing(let p): return "\(p) not found. Run: meeting-recorder repair"
            case .unreadable(let p): return "\(p) is invalid. Run: meeting-recorder repair"
            case .notExecutable(let p): return "Node runtime missing at \(p). Run: meeting-recorder repair"
            }
        }
    }

    public static func load(home: String = defaultHome(), fileManager: FileManager = .default) -> Result<AgentConfig, LoadError> {
        let path = (home as NSString).appendingPathComponent("agent.json")
        guard let data = fileManager.contents(atPath: path) else { return .failure(.missing(path)) }
        guard let config = try? JSONDecoder().decode(AgentConfig.self, from: data),
              config.nodePath.hasPrefix("/"), config.daemonEntry.hasPrefix("/"), config.meetingsDir.hasPrefix("/")
        else { return .failure(.unreadable(path)) }
        guard fileManager.isExecutableFile(atPath: config.nodePath) else { return .failure(.notExecutable(config.nodePath)) }
        return .success(config)
    }
}

/// Exponential backoff for restarting the daemon: 1, 2, 4 … 30 s, reset after a healthy minute.
public struct Backoff: Sendable {
    public private(set) var attempt = 0
    public let base: TimeInterval
    public let cap: TimeInterval

    public init(base: TimeInterval = 1, cap: TimeInterval = 30) {
        self.base = base
        self.cap = cap
    }

    public mutating func next() -> TimeInterval {
        defer { attempt += 1 }
        return min(cap, base * pow(2, Double(attempt)))
    }

    public mutating func reset() { attempt = 0 }
}
