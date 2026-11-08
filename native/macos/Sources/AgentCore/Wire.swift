// NDJSON wire format between this agent and the Node daemon (docs/protocol.md).
//
//   agent ──(daemon stdin)──▶  AgentEvent lines
//   agent ◀─(daemon stdout)──  DaemonCommand lines, validated here before anything acts on them
//
// Types come from packages/shared/protocol.schema.json (Protocol.gen.swift). Codable can't enforce
// the schema's patterns or additionalProperties:false, so CommandValidator applies those rules.
import Foundation

public enum DaemonCommand: Equatable, Sendable {
    case start(StartCommand)
    case stop(StopCommand)
    case state(StateCommand)
    case openUrl(OpenUrlCommand)
    case share(ShareCommand)
}

public enum WireError: Error, Equatable, CustomStringConvertible {
    case notJSONObject
    case unknownCommand(String)
    case unexpectedKeys([String])
    case decoding(String)
    case invalid(String)

    public var description: String {
        switch self {
        case .notJSONObject: return "not a JSON object"
        case .unknownCommand(let c): return "unknown command \(c)"
        case .unexpectedKeys(let k): return "unexpected keys \(k.joined(separator: ","))"
        case .decoding(let m): return "decoding failed: \(m)"
        case .invalid(let m): return m
        }
    }
}

public struct CommandValidator: Sendable {
    /// Same rule as the schema's MeetingId definition.
    public static let meetingIdPattern = #"^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}_[a-z0-9-]{1,40}$"#

    /// When set, start paths must be <meetingsDir>/<meetingId>/recording.mp4 exactly.
    public let meetingsDir: String?

    public init(meetingsDir: String? = nil) {
        self.meetingsDir = meetingsDir.map { ($0 as NSString).standardizingPath }
    }

    private static let allowedKeys: [String: Set<String>] = [
        "start": ["cmd", "meetingId", "path", "height", "fps", "liveLocale"],
        "stop": ["cmd", "meetingId"],
        "state": ["cmd", "status", "label"],
        "openUrl": ["cmd", "url"],
        "share": ["cmd", "meetingId", "file"],
    ]

    public func decode(_ line: String) -> Result<DaemonCommand, WireError> {
        let data = Data(line.utf8)
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .failure(.notJSONObject)
        }
        guard let cmd = object["cmd"] as? String, let allowed = Self.allowedKeys[cmd] else {
            return .failure(.unknownCommand(String(describing: object["cmd"] ?? "nil")))
        }
        let extra = Set(object.keys).subtracting(allowed)
        if !extra.isEmpty { return .failure(.unexpectedKeys(extra.sorted())) }

        do {
            let decoder = JSONDecoder()
            let command: DaemonCommand
            switch cmd {
            case "start": command = .start(try decoder.decode(StartCommand.self, from: data))
            case "stop": command = .stop(try decoder.decode(StopCommand.self, from: data))
            case "state": command = .state(try decoder.decode(StateCommand.self, from: data))
            case "share": command = .share(try decoder.decode(ShareCommand.self, from: data))
            default: command = .openUrl(try decoder.decode(OpenUrlCommand.self, from: data))
            }
            if let problem = validate(command) { return .failure(.invalid(problem)) }
            return .success(command)
        } catch {
            return .failure(.decoding(String(describing: error)))
        }
    }

    /// Returns a description of the first rule broken, or nil when the command is valid.
    public func validate(_ command: DaemonCommand) -> String? {
        switch command {
        case .start(let c):
            guard Self.isMeetingId(c.meetingId) else { return "invalid meetingId" }
            guard [720, 1080].contains(c.height) else { return "invalid height" }
            guard [10, 15, 30].contains(c.fps) else { return "invalid fps" }
            if let locale = c.liveLocale, locale.range(of: #"^(auto|[a-z]{2,3}(_[A-Z]{2})?)$"#, options: .regularExpression) == nil { return "invalid liveLocale" }
            guard c.path.hasPrefix("/"), c.path.hasSuffix("/recording.mp4"), !c.path.contains("/../") else { return "invalid path" }
            if let dir = meetingsDir {
                let expected = (dir as NSString).appendingPathComponent("\(c.meetingId)/recording.mp4")
                guard (c.path as NSString).standardizingPath == expected else { return "path outside the meetings folder" }
            }
            return nil
        case .stop(let c):
            return Self.isMeetingId(c.meetingId) ? nil : "invalid meetingId"
        case .state(let c):
            return (c.label?.count ?? 0) <= 200 ? nil : "label too long"
        case .openUrl(let c):
            guard let url = URL(string: c.url), url.scheme == "http", url.host == "127.0.0.1",
                  let port = url.port, (1...65535).contains(port), c.url.hasPrefix("http://127.0.0.1:\(port)/")
            else { return "only the local dashboard may be opened" }
            return nil
        case .share(let c):
            return Self.isMeetingId(c.meetingId) ? nil : "invalid meetingId" // file is a fixed enum
        }
    }

    public static func isMeetingId(_ id: String) -> Bool {
        id.range(of: meetingIdPattern, options: .regularExpression) != nil
    }
}

/// Encodes events as single NDJSON lines (no embedded newlines; nil optionals omitted).
public enum EventEncoder {
    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()

    public static func line<T: Encodable>(_ event: T) -> String {
        // Encoding our own value types cannot fail; a crash here would be a programming error.
        let data = try! encoder.encode(event)
        return String(decoding: data, as: UTF8.self) + "\n"
    }

    public static func hello(agentVersion: String, activeMeetingId: String?) -> String {
        line(HelloEvent(activeMeetingId: activeMeetingId, agentVersion: agentVersion, platform: .macos,
                        protocolVersion: protocolVersion, type: .hello))
    }

    public static func mic(users: [MicUser], windows: [WindowInfo]) -> String {
        line(MicEvent(type: .mic, users: users, windows: windows))
    }

    public static func recording(_ state: RecordingState, meetingId: String, durationSec: Double? = nil, error: AgentError? = nil) -> String {
        line(RecordingEvent(durationSec: durationSec, error: error, meetingId: meetingId, state: state, type: .recording))
    }

    public static func transcript(meetingId: String, speaker: Speaker, start: Double, end: Double, text: String) -> String {
        line(TranscriptEvent(end: end, meetingId: meetingId, speaker: speaker, start: start, text: String(text.prefix(4000)), type: .transcript))
    }
    public static func tray(_ action: TrayAction) -> String { line(TrayEvent(action: action, type: .tray)) }
    public static func power(_ state: PowerState) -> String { line(PowerEvent(state: state, type: .power)) }
    public static func permission(_ state: PermissionState) -> String { line(PermissionEvent(screen: state, type: .permission)) }
}

/// Splits a byte stream into lines, tolerating chunks that end mid-line and CRLF endings.
public struct LineBuffer: Sendable {
    private var pending = Data()
    public static let maxLineBytes = 1 << 20

    public init() {}

    public mutating func append(_ chunk: Data) -> [String] {
        pending.append(chunk)
        var lines: [String] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            var lineData = pending[pending.startIndex..<newline]
            if lineData.last == 0x0D { lineData = lineData.dropLast() }
            pending.removeSubrange(pending.startIndex...newline)
            if !lineData.isEmpty, lineData.count <= Self.maxLineBytes { lines.append(String(decoding: lineData, as: UTF8.self)) }
        }
        if pending.count > Self.maxLineBytes { pending.removeAll() } // runaway line without newline
        return lines
    }
}
