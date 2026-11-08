import Foundation

/// Append-only agent log (~/.meeting-recorder/logs/agent.log), rotated at 5 MB, one generation kept.
/// No meeting content is logged: ids, states and errors only.
enum Log {
    private static let queue = DispatchQueue(label: "agent.log")
    private static var handle: FileHandle?
    private static var path = ""

    static func open(home: String) {
        let dir = (home as NSString).appendingPathComponent("logs")
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        path = (dir as NSString).appendingPathComponent("agent.log")
        if let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int, size > 5_000_000 {
            try? FileManager.default.removeItem(atPath: path + ".1")
            try? FileManager.default.moveItem(atPath: path, toPath: path + ".1")
        }
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        handle = FileHandle(forWritingAtPath: path)
        handle?.seekToEndOfFile()
    }

    static func info(_ message: String) { write("INFO", message) }
    static func warn(_ message: String) { write("WARN", message) }

    private static func write(_ level: String, _ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(level) \(message)\n"
        queue.async { handle?.write(Data(line.utf8)) }
    }
}
