// --merge <meeting dir>: joins the separately recorded streams (parts.json) into recording.mp4.
//   per stream: one track; each part's media placed at its start time (MergePlan trims overlap)
//   ─▶ AVAssetExportSession passthrough (no re-encode: a 1-hour meeting takes seconds)
//   ─▶ recording.merging.mp4, then renamed. Parts are left for the daemon to remove.
// The daemon trims each part's unfinished tail first, so every part reads cleanly.
import AgentCore
import AVFoundation

enum Merger {
    /// The merged duration and the parts actually used. A part that exists but can't be read makes
    /// the merge fail (the daemon keeps every part and retries) rather than being silently dropped.
    static func run(directory: URL) async throws -> (durationSec: Double, merged: [String]) {
        let manifest = try PartsManifest.read(from: directory)
        let composition = AVMutableComposition()
        // The source assets must outlive the export: a track doesn't keep its asset alive, and an
        // export reading from a released asset fails (-12780).
        var assets: [AVURLAsset] = []
        for stream in PartsManifest.streams {
            let mediaType: AVMediaType = stream == "video" ? .video : .audio
            var sources: [(file: String, start: Double, duration: Double, track: AVAssetTrack)] = []
            for part in manifest.parts where part.stream == stream {
                let url = directory.appendingPathComponent(part.file)
                guard FileManager.default.fileExists(atPath: url.path) else { continue }
                let asset = AVURLAsset(url: url)
                assets.append(asset)
                let track: AVAssetTrack?
                do { track = try await asset.loadTracks(withMediaType: mediaType).first }
                catch { throw ModelError("\(part.file) couldn't be read: \(describe(error))") }
                guard let track else { continue } // trimmed to nothing: no media in this part
                let range = try await track.load(.timeRange)
                guard range.duration.seconds > 0 else { continue }
                sources.append((part.file, part.start, range.duration.seconds, track))
            }
            guard !sources.isEmpty,
                  let target = composition.addMutableTrack(withMediaType: mediaType, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
            for placement in MergePlan.place(sources.map { ($0.file, $0.start, $0.duration) }) {
                guard let source = sources.first(where: { $0.file == placement.file }) else { continue }
                // Precise clock (rounding a range past the media's end makes the export fail with
                // -12780), and always clamped to the media that is really there.
                let available = try await source.track.load(.timeRange)
                let wanted = CMTimeRange(start: available.start + CMTime(seconds: placement.sourceStart, preferredTimescale: 1_000_000),
                                         duration: CMTime(seconds: placement.duration, preferredTimescale: 1_000_000))
                let range = CMTimeRangeGetIntersection(wanted, otherRange: available)
                guard range.duration.seconds > 0 else { continue }
                try target.insertTimeRange(range, of: source.track, at: CMTime(seconds: placement.at, preferredTimescale: 1_000_000))
            }
        }
        guard !composition.tracks.isEmpty else { throw ModelError("No recorded media to merge.") }

        let output = directory.appendingPathComponent("recording.mp4")
        let partial = directory.appendingPathComponent("recording.merging.mp4") // the exporter wants a .mp4 name
        try? FileManager.default.removeItem(at: partial)
        guard let export = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough) else {
            throw ModelError("Couldn't prepare the merge.")
        }
        try await export.export(to: partial, as: .mp4)
        withExtendedLifetime(assets) {}
        let used = Set(composition.tracks.isEmpty ? [] : manifest.parts.map(\.file).filter { file in
            FileManager.default.fileExists(atPath: directory.appendingPathComponent(file).path) })
        try? FileManager.default.removeItem(at: output)
        try FileManager.default.moveItem(at: partial, to: output)
        return (composition.duration.seconds, used.sorted())
    }
}
