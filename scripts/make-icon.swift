// Draws the Meeting Recorder app icon (a waveform on deep teal, with a red recording dot) at every
// size macOS needs, then packs it into native/macos/Resources/AppIcon.icns with iconutil.
//   swift scripts/make-icon.swift      (run from the repo root; regenerates the committed icon)
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let iconset = FileManager.default.temporaryDirectory.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func draw(_ px: Int) -> Data {
    let s = CGFloat(px)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let ctx = NSGraphicsContext.current!.cgContext

    // macOS icon grid: the tile is ~80% of the canvas, centred, with a soft shadow.
    let inset = s * 0.1, tile = CGRect(x: inset, y: inset * 1.15, width: s - inset * 2, height: s - inset * 2)
    let radius = tile.width * 0.225
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -s * 0.012), blur: s * 0.03, color: NSColor.black.withAlphaComponent(0.28).cgColor)
    let path = CGPath(roundedRect: tile, cornerWidth: radius, cornerHeight: radius, transform: nil)
    ctx.addPath(path)
    ctx.clip()
    let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
        NSColor(srgbRed: 0.09, green: 0.55, blue: 0.51, alpha: 1).cgColor,   // teal
        NSColor(srgbRed: 0.06, green: 0.20, blue: 0.27, alpha: 1).cgColor,   // deep ink-teal
    ] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(gradient, start: CGPoint(x: tile.minX, y: tile.maxY), end: CGPoint(x: tile.maxX, y: tile.minY), options: [])
    ctx.restoreGState()

    // Waveform: symmetric rounded bars, like a voice at mid-sentence.
    let heights: [CGFloat] = [0.18, 0.34, 0.56, 0.42, 0.72, 0.5, 0.3, 0.46, 0.24]
    let barW = tile.width * 0.055, gap = tile.width * 0.035
    let total = CGFloat(heights.count) * barW + CGFloat(heights.count - 1) * gap
    var x = tile.midX - total / 2
    ctx.setFillColor(NSColor.white.withAlphaComponent(0.96).cgColor)
    for h in heights {
        let barH = tile.height * h * 0.78
        let bar = CGRect(x: x, y: tile.midY - barH / 2, width: barW, height: barH)
        ctx.addPath(CGPath(roundedRect: bar, cornerWidth: barW / 2, cornerHeight: barW / 2, transform: nil))
        ctx.fillPath()
        x += barW + gap
    }

    // Recording dot, top right, with a light ring so it reads at small sizes.
    let d = tile.width * 0.17
    let dot = CGRect(x: tile.maxX - d * 1.45, y: tile.maxY - d * 1.45, width: d, height: d)
    ctx.setFillColor(NSColor.white.withAlphaComponent(0.9).cgColor)
    ctx.fillEllipse(in: dot.insetBy(dx: -d * 0.12, dy: -d * 0.12))
    ctx.setFillColor(NSColor(srgbRed: 0.90, green: 0.28, blue: 0.30, alpha: 1).cgColor)
    ctx.fillEllipse(in: dot)

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

for size in [16, 32, 128, 256, 512] {
    try! draw(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try! draw(size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
let out = root.appendingPathComponent("native/macos/Resources/AppIcon.icns")
let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
task.arguments = ["-c", "icns", iconset.path, "-o", out.path]
try! task.run()
task.waitUntilExit()
try! draw(512).write(to: root.appendingPathComponent("docs/icon.png"))
print(task.terminationStatus == 0 ? "wrote \(out.path) and docs/icon.png" : "iconutil failed")
