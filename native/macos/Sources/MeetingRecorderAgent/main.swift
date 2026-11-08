// Meeting Recorder agent: a menu-bar-only app (LSUIElement). Started at login by launchd.
//   --mic-probe [seconds]   diagnostics: print which processes use a mic (no UI, no prompts)
import AppKit
import Foundation

if let i = CommandLine.arguments.firstIndex(of: "--mic-probe") {
    let seconds = CommandLine.arguments.dropFirst(i + 1).first.flatMap(Double.init) ?? 10
    let end = Date().addingTimeInterval(seconds)
    var last = ""
    while Date() < end {
        let now = MicMonitor.inputProcesses().map { "\($0.bundleId) (pid \($0.pid))" }.sorted().joined(separator: ", ")
        if now != last { print("\(ISO8601DateFormatter().string(from: Date())) mic in use by: \(now.isEmpty ? "nobody" : now)"); last = now }
        Thread.sleep(forTimeInterval: 0.5)
    }
    exit(0)
}

let app = NSApplication.shared
let controller = AppController()
app.delegate = controller
app.setActivationPolicy(.accessory)
app.run()
