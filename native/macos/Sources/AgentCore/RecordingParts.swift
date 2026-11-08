// Separate-stream recording: video, system audio and microphone are each written to their own
// crash-safe file ("parts"), on one shared clock, and merged into recording.mp4 after the meeting.
//
//   meeting folder/
//     video-1.mp4  system-1.mp4  mic-1.mp4      one writer per stream (fragmented MP4, 5 s)
//     video-2.mp4 …                              a writer that fails restarts as the next part
//     parts.json                                 which part starts when (seconds from the start)
//     recording.mp4                              the merge (helper --merge), parts then removed
//
// A failure now costs one stream a few seconds, not the rest of the meeting. Otter and Granola
// avoid the problem by never muxing at all (audio only, streamed); we keep video, but never mux
// it with audio while recording.
import Foundation

public struct PartsManifest: Codable, Equatable, Sendable {
    public struct Part: Codable, Equatable, Sendable {
        public let stream: String      // "video", "system" or "mic"
        public let file: String        // e.g. "mic-2.mp4", always a bare file name in the folder
        public let start: Double       // seconds from the recording's start (the first video frame)
        public init(stream: String, file: String, start: Double) { self.stream = stream; self.file = file; self.start = start }
    }

    public static let fileName = "parts.json"
    public static let streams = ["video", "system", "mic"]
    public var version = 1
    public var parts: [Part]

    public init(parts: [Part] = []) { self.parts = parts }

    public func write(to directory: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try FileWriting.atomic(try encoder.encode(self), to: directory.appendingPathComponent(Self.fileName))
    }

    public static func read(from directory: URL) throws -> PartsManifest {
        let manifest = try JSONDecoder().decode(PartsManifest.self, from: Data(contentsOf: directory.appendingPathComponent(fileName)))
        // Only plain file names of known streams: the manifest can't point outside the folder.
        let valid = manifest.parts.allSatisfy { part in
            streams.contains(part.stream) && part.start.isFinite && part.start >= 0
                && part.file.range(of: #"^(video|system|mic)-[0-9]{1,4}\.mp4$"#, options: .regularExpression) != nil
        }
        guard valid else { throw CocoaError(.fileReadCorruptFile) }
        return manifest
    }
}

/// Where each part's media goes on the merged timeline. Parts of one stream normally follow each
/// other; if a restarted part overlaps the previous one, the overlap is trimmed off its start so
/// the merged track never has two samples for the same moment.
public enum MergePlan {
    public struct Placement: Equatable, Sendable {
        public let file: String
        public let sourceStart: Double   // seconds into the part's own media
        public let duration: Double
        public let at: Double            // seconds on the merged timeline
        public init(file: String, sourceStart: Double, duration: Double, at: Double) {
            self.file = file; self.sourceStart = sourceStart; self.duration = duration; self.at = at
        }
    }

    public static func place(_ parts: [(file: String, start: Double, duration: Double)]) -> [Placement] {
        var cursor = 0.0
        var placements: [Placement] = []
        for part in parts.sorted(by: { $0.start < $1.start }) where part.duration > 0 {
            let at = max(part.start, cursor)
            let skip = at - part.start
            let duration = part.duration - skip
            guard duration > 0.001 else { continue }
            placements.append(Placement(file: part.file, sourceStart: skip, duration: duration, at: at))
            cursor = at + duration
        }
        return placements
    }
}
