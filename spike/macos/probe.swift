// Spike T1 helper: report what a recording actually contains, so the checklist isn't judged by ear alone.
// Build: swiftc -O -swift-version 5 probe.swift -o probe
// Run:   ./probe spike-recording.mp4

import AVFoundation
import Foundation

guard CommandLine.arguments.count > 1 else {
    print("usage: probe <file.mp4>"); exit(64)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)

do {
    let duration = try await asset.load(.duration)
    let tracks = try await asset.load(.tracks)
    let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    print(String(format: "file=%@ size=%.1fMB duration=%.1fs tracks=%d",
                 url.lastPathComponent, Double(bytes) / 1_048_576, duration.seconds, tracks.count))
    for track in tracks {
        let range = try await track.load(.timeRange)
        let rate = try await track.load(.estimatedDataRate)
        var detail = ""
        if track.mediaType == .video {
            let size = try await track.load(.naturalSize)
            let fps = try await track.load(.nominalFrameRate)
            detail = String(format: " %.0fx%.0f @%.1ffps", size.width, size.height, fps)
        }
        print(String(format: "  track %d %@ start=%.2fs duration=%.1fs bitrate=%.0fkbps%@",
                     track.trackID, track.mediaType.rawValue, range.start.seconds, range.duration.seconds, rate / 1000, detail))
    }
    // Spike check 1 needs exactly the expected layout: 1 video + 2 audio (system, mic).
    let videoCount = tracks.filter { $0.mediaType == .video }.count
    let audioCount = tracks.filter { $0.mediaType == .audio }.count
    if videoCount == 1 && audioCount == 2 {
        print("OK 1 video + 2 audio tracks")
    } else {
        print("FAIL expected 1 video + 2 audio tracks, got \(videoCount) video + \(audioCount) audio")
        exit(1)
    }
} catch {
    print("ERROR cannot read \(url.path): \(error.localizedDescription)")
    exit(1)
}
