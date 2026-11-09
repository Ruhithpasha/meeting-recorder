// Logic checks for AgentCore. The Command Line Tools ship without XCTest/swift-testing, so this is
// a plain executable: `swift run AgentCoreChecks` (exit 1 on any failure). It decodes the SAME
// protocol fixtures as the TypeScript tests, so both sides agree on what is valid.
import AVFoundation
import AgentCore
import CoreMedia
import Foundation

var failures = 0
var passed = 0
func check(_ condition: @autoclosure () -> Bool, _ name: String, file: StaticString = #fileID, line: UInt = #line) {
    if condition() { passed += 1 } else { failures += 1; print("FAIL \(name) (\(file):\(line))") }
}

let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let fixtures = packageDir.appendingPathComponent("../../packages/shared/fixtures/protocol").standardizedFileURL
func fixtureLines(_ dir: String) -> [(String, String)] {
    let url = fixtures.appendingPathComponent(dir)
    let names = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
    return names.sorted().compactMap { name in
        (try? String(contentsOf: url.appendingPathComponent(name), encoding: .utf8)).map { (name, $0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    }
}

// MARK: Wire: daemon commands (shared fixtures)
let validator = CommandValidator()
let validCommands = fixtureLines("valid").filter { $0.0.hasPrefix("cmd-") }
let invalidCommands = fixtureLines("invalid").filter { $0.0.hasPrefix("cmd-") }
check(!validCommands.isEmpty && !invalidCommands.isEmpty, "shared command fixtures found at \(fixtures.path)")
for (name, line) in validCommands {
    if case .failure(let error) = validator.decode(line) { check(false, "valid fixture \(name) rejected: \(error)") } else { passed += 1 }
}
for (name, line) in invalidCommands {
    if case .success = validator.decode(line) { check(false, "invalid fixture \(name) accepted") } else { passed += 1 }
}
check(validator.decode(#"{"cmd":"stop","meetingId":"2026-11-08_14-30-05_zoom","x":1}"#) == .failure(.unexpectedKeys(["x"])), "extra keys rejected")
check(validator.decode("[]") == .failure(.notJSONObject), "non-object rejected")
check(validator.decode(#"{"cmd":"explode"}"#) == .failure(.unknownCommand("explode")), "unknown cmd rejected")

let scoped = CommandValidator(meetingsDir: "/Users/me/Meetings")
let inside = #"{"cmd":"start","meetingId":"2026-11-08_14-30-05_zoom","path":"/Users/me/Meetings/2026-11-08_14-30-05_zoom/recording.mp4","height":720,"fps":15}"#
let outside = #"{"cmd":"start","meetingId":"2026-11-08_14-30-05_zoom","path":"/tmp/2026-11-08_14-30-05_zoom/recording.mp4","height":720,"fps":15}"#
let otherId = #"{"cmd":"start","meetingId":"2026-11-08_14-30-05_zoom","path":"/Users/me/Meetings/2026-11-08_14-30-05_teams/recording.mp4","height":720,"fps":15}"#
if case .success = scoped.decode(inside) { passed += 1 } else { check(false, "path inside meetings dir accepted") }
check(scoped.decode(outside) == .failure(.invalid("path outside the meetings folder")), "path outside meetings dir rejected")
check(scoped.decode(otherId) == .failure(.invalid("path outside the meetings folder")), "path for another meeting rejected")
for url in ["http://127.0.0.1:47321/#t=x", "http://127.0.0.1:1/"] {
    if case .success = validator.decode(#"{"cmd":"openUrl","url":"\#(url)"}"#) { passed += 1 } else { check(false, "openUrl \(url) accepted") }
}
for url in ["file:///Applications/Calculator.app", "https://127.0.0.1:47321/", "http://127.0.0.1.evil.com:80/", "http://localhost:47321/", "http://127.0.0.1/"] {
    if case .failure = validator.decode(#"{"cmd":"openUrl","url":"\#(url)"}"#) { passed += 1 } else { check(false, "openUrl \(url) rejected") }
}

// MARK: Wire: agent events round-trip through the schema's shapes
let hello = EventEncoder.hello(agentVersion: "0.1.0", activeMeetingId: nil)
check(hello == #"{"agentVersion":"0.1.0","platform":"macos","protocolVersion":\#(protocolVersion),"type":"hello"}"# + "\n", "hello omits nil activeMeetingId")
check(EventEncoder.hello(agentVersion: "0.1.0", activeMeetingId: "2026-11-08_14-30-05_zoom").contains(#""activeMeetingId":"2026-11-08_14-30-05_zoom""#), "hello includes active meeting")
let stopped = EventEncoder.recording(.stopped, meetingId: "2026-11-08_14-30-05_zoom", durationSec: 12.5)
check(stopped == #"{"durationSec":12.5,"meetingId":"2026-11-08_14-30-05_zoom","state":"stopped","type":"recording"}"# + "\n", "recording stopped line")
let mic = EventEncoder.mic(users: [MicUser(bundleId: "us.zoom.xos", pid: 4)], windows: [WindowInfo(bundleId: "a", title: "line\nbreak \"quoted\" / slash")])
check(mic.filter { $0 == "\n" }.count == 1 && mic.hasSuffix("\n"), "encoded events are exactly one line")
check(EventEncoder.tray(.openDashboard) == #"{"action":"openDashboard","type":"tray"}"# + "\n", "tray line")
check(EventEncoder.permission(.denied) == #"{"screen":"denied","type":"permission"}"# + "\n", "permission line")
check(EventEncoder.power(.ac) == #"{"state":"ac","type":"power"}"# + "\n", "power line")
// Every valid agent fixture decodes into the generated types (same shapes the encoder produces).
for (name, line) in fixtureLines("valid") where !name.hasPrefix("cmd-") {
    check((try? JSONSerialization.jsonObject(with: Data(line.utf8))) != nil, "agent fixture \(name) is JSON")
}

// MARK: LineBuffer
var buffer = LineBuffer()
check(buffer.append(Data(#"{"a":1}"#.utf8)) == [], "partial line held")
check(buffer.append(Data("\r\n{\"b\":2}\n\n".utf8)) == [#"{"a":1}"#, #"{"b":2}"#], "CRLF and blank lines handled")
check(buffer.append(Data(repeating: 0x41, count: LineBuffer.maxLineBytes + 10)) == [], "runaway line dropped")
check(buffer.append(Data("ok\n".utf8)) == ["ok"], "buffer recovers after runaway line")

// MARK: Capture math (spike findings)
check(CaptureMath.evenWidth(displayWidth: 1920, displayHeight: 1080, height: 720) == 1280, "16:9 width")
check(CaptureMath.evenWidth(displayWidth: 1512, displayHeight: 982, height: 720) == 1108, "MacBook 14 width (spike)")
check(CaptureMath.evenWidth(displayWidth: 1, displayHeight: 1000, height: 720) == 2, "tiny width clamps")
check(CaptureMath.videoBitrate(height: 720, fps: 15) == 1_500_000, "720p15 bitrate")
check(CaptureMath.videoBitrate(height: 720, fps: 30) == 2_500_000, "720p30 bitrate")
check(CaptureMath.videoBitrate(height: 1080, fps: 30) == 5_000_000, "1080p30 bitrate")
check(CaptureMath.videoBitrate(height: 720, fps: 10) == 1_000_000, "720p10 bitrate")
var pacer30 = FramePacer(fps: 30)
check(pacer30.accept(CMTime(value: 0, timescale: 30_000)) && pacer30.accept(CMTime(value: 1_001, timescale: 30_000)), "30 fps frames (1/30 s apart) pass the pacer")
check(!pacer30.accept(CMTime(value: 1_400, timescale: 30_000)), "a 75 fps duplicate is still dropped at 30 fps")
var pacer = FramePacer(fps: 15)
let t = { (s: Double) in CMTime(seconds: s, preferredTimescale: 600) }
check(pacer.accept(t(0)), "first frame accepted")
check(!pacer.accept(t(0.02)), "48 fps frame dropped")
check(pacer.accept(t(0.062)), "frame at ~0.93 period accepted")
check(pacer.accept(t(0.2)), "late frame accepted")

// MARK: Backoff
var backoff = Backoff()
check((0..<7).map { _ in backoff.next() } == [1, 2, 4, 8, 16, 30, 30], "backoff doubles to a 30 s cap")
backoff.reset()
check(backoff.next() == 1, "backoff resets")

// MARK: MicSnapshot
let a = MicSnapshot(users: [MicUser(bundleId: "b", pid: 2), MicUser(bundleId: "a", pid: 1)], windows: [])
let b = MicSnapshot(users: [MicUser(bundleId: "a", pid: 1), MicUser(bundleId: "b", pid: 2)], windows: [])
check(a == b, "snapshots compare by value regardless of order")
check(MicSnapshot.relevantWindows([WindowInfo(bundleId: "x", title: "t")], whenUsers: []).isEmpty, "no titles without mic users")
let many = (0..<80).map { WindowInfo(bundleId: "x", title: $0 == 0 ? "" : String(repeating: "y", count: 400)) }
let kept = MicSnapshot.relevantWindows(many, whenUsers: [MicUser(bundleId: "a", pid: 1)])
check(kept.count == MicSnapshot.maxWindows && kept.allSatisfy { $0.title.count == 300 }, "titles capped in count and length, empty dropped")

// MARK: Transcript
check(Transcript.speakerLabels(trackCount: 2) == ["Others", "You"], "two tracks: system = Others, mic = You")
check(Transcript.speakerLabels(trackCount: 1) == ["Speaker"], "one track label")
check(Transcript.speakerLabels(trackCount: 3) == ["Track 1", "Track 2", "Track 3"], "more tracks get numbered")
check(Transcript.timestamp(0) == "00:00:00.000" && Transcript.timestamp(3725.5) == "01:02:05.500", "VTT timestamps")
let transcript = Transcript(language: "en_US", durationSec: 9, segments: [
    .init(start: 4, end: 5, speaker: "You", text: "second"),
    .init(start: 1, end: 2, speaker: "Others", text: "first --> line\nbreak"),
])
check(transcript.segments.map(\.text) == ["first --> line\nbreak", "second"], "segments merged into one timeline")
let vtt = transcript.vtt()
check(vtt.hasPrefix("WEBVTT\n") && vtt.contains("<v Others>first -> line break") && !vtt.contains("first -->"), "VTT escapes cue arrows and newlines")
let txDir = FileManager.default.temporaryDirectory.appendingPathComponent("mr-tx-\(UUID().uuidString)")
try? FileManager.default.createDirectory(at: txDir, withIntermediateDirectories: true)
try? transcript.write(to: txDir)
let decoded = (try? Data(contentsOf: txDir.appendingPathComponent("transcript.json"))).flatMap { try? JSONDecoder().decode(Transcript.self, from: $0) }
check(decoded == transcript, "transcript.json round-trips")
try? transcript.write(to: txDir) // overwrite works (atomic replace)
check(FileManager.default.fileExists(atPath: txDir.appendingPathComponent("transcript.vtt").path), "transcript.vtt written")
try? FileManager.default.removeItem(at: txDir)

// MARK: Summary
let summaryModel = MeetingSummary(overview: "  Weekly sync. ", keyPoints: ["a", " ", "b"], decisions: [], actionItems: ["Priya: send deck"])
check(summaryModel.overview == "Weekly sync." && summaryModel.keyPoints == ["a", "b"], "summary trims and drops empty items")
let md = summaryModel.markdown(title: "Sync")
check(md.hasPrefix("# Sync\n\nWeekly sync.") && md.contains("## Key points\n\n- a\n- b") && md.contains("## Action items") && !md.contains("## Decisions"), "summary markdown skips empty sections")
check(TranscriptChunker.chunks(["a", "b", "c"], maxTokens: 100) == ["a\nb\nc"], "short transcript is one chunk")
let long = (0..<10).map { "Speaker: \(String(repeating: "x", count: 30)) \($0)" }
let parts = TranscriptChunker.chunks(long, maxTokens: 25)
check(parts.count > 1 && parts.allSatisfy { TranscriptChunker.estimatedTokens($0) <= 25 } && parts.joined(separator: "\n") == long.joined(separator: "\n"), "chunks fit the token budget and keep every line, in order")
check(TranscriptChunker.chunks([String(repeating: "y", count: 1000)], maxTokens: 100).allSatisfy { TranscriptChunker.estimatedTokens($0) <= 100 }, "a single huge line is cut to fit")
check(TranscriptChunker.chunks([]) == [], "empty transcript has no chunks")
check(TranscriptChunker.estimatedTokens("abcdefgh") == 2 && TranscriptChunker.estimatedTokens("会議の要約") == 5, "CJK counts about one token per character")
let cjk = TranscriptChunker.chunks(Array(repeating: String(repeating: "会", count: 300), count: 20), maxTokens: 2000)
check(cjk.count >= 3 && cjk.allSatisfy { TranscriptChunker.estimatedTokens($0) <= 2000 }, "CJK transcripts are split so each part fits the window")

// MARK: Open-model text
check(OpenModelText.whisperLanguage("hi_IN") == "hi" && OpenModelText.whisperLanguage("auto") == nil && OpenModelText.whisperLanguage(nil) == nil, "settings language -> Whisper code")
check(OpenModelText.majorityLanguage(["en", "hi", "hi", ""]) == "hi" && OpenModelText.majorityLanguage([]) == nil, "auto language: majority of the call track, not its first chunk")
check(OpenModelText.cleanWhisper("<|startoftranscript|><|en|><|0.00|> Good  morning.<|3.52|>") == "Good morning.", "Whisper special tokens stripped")
check(OpenModelText.cleanWhisper("bye Thank you. Продолжение следует...") == "bye Thank you.", "Whisper subtitle credit removed, real thanks kept")
check(OpenModelText.cleanWhisper("Thanks for watching!") == "" && OpenModelText.cleanWhisper("Subtitles by the Amara.org community") == "", "subtitle-credit-only lines become empty (then dropped)")
let qwenOut = #"{"overview":"Sync.","keyPoints":["a"],"decisions":[],"actionItems":["Priya: docs"]} [end of text]"#
check(OpenModelText.parseSummary(qwenOut) == MeetingSummary(overview: "Sync.", keyPoints: ["a"], decisions: [], actionItems: ["Priya: docs"]), "Qwen JSON summary parsed despite trailing text")
check(OpenModelText.parseSummary("no json") == nil && OpenModelText.parseSummary(#"{"keyPoints":[]}"#) == nil, "bad summary output rejected")
check(OpenModelText.parseNotes(#"{"points":["one","two"]}"#) == "- one\n- two", "Qwen notes parsed")
check(OpenModelText.chatPrompt(system: "S", user: "U").hasSuffix("<think>\n\n</think>\n\n") && OpenModelText.chatPrompt(system: "S", user: "U").contains("U /no_think"), "Qwen prompt has thinking off")

// MARK: Whisper manifest (supply chain: every file pinned and fingerprinted)
let wPaths = Set(WhisperManifest.files.map(\.path))
check(["AudioEncoder.mlmodelc", "TextDecoder.mlmodelc", "MelSpectrogram.mlmodelc"].allSatisfy { bundle in wPaths.contains { $0.hasPrefix("\(WhisperManifest.modelFolder)/\(bundle)/") } }
      && wPaths.contains("models/openai/whisper-large-v3/tokenizer.json"), "manifest has the model bundles WhisperKit loads and the tokenizer")
check(WhisperManifest.files.allSatisfy { $0.path.hasPrefix(WhisperManifest.modelFolder + "/") || $0.path.hasPrefix("models/openai/whisper-large-v3/") }, "every Whisper file sits in the loaded folder or the tokenizer folder")
// filesToFetch: first run hashes, resumes; after the marker only a stat (offline), and repairs.
let wRoot = FileManager.default.temporaryDirectory.appendingPathComponent("mr-whisper-\(UUID().uuidString)")
func place(_ file: WhisperManifest.File, size: Int64? = nil) {
    let url = wRoot.appendingPathComponent(file.path)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: url.path, contents: Data(count: Int(min(size ?? file.size, 64))))
    if (size ?? file.size) > 64 { let h = try! FileHandle(forWritingTo: url); try! h.truncate(atOffset: UInt64(size ?? file.size)); try! h.close() }
}
let fakeHash: (URL) -> String? = { url in WhisperManifest.files.first { wRoot.appendingPathComponent($0.path) == url }?.sha256 }
check(WhisperManifest.filesToFetch(root: wRoot, hash: fakeHash).count == WhisperManifest.files.count, "empty folder: fetch everything")
for f in WhisperManifest.files.dropLast() { place(f) }
check(WhisperManifest.filesToFetch(root: wRoot, hash: fakeHash).map(\.path) == [WhisperManifest.files.last!.path], "interrupted download resumes with the missing file only")
place(WhisperManifest.files.last!)
check(WhisperManifest.filesToFetch(root: wRoot, hash: { _ in "bad" }).count == WhisperManifest.files.count, "unverified files with wrong hashes are fetched again")
FileManager.default.createFile(atPath: wRoot.appendingPathComponent(WhisperManifest.marker).path, contents: Data())
var hashed = 0
check(WhisperManifest.filesToFetch(root: wRoot, hash: { _ in hashed += 1; return "bad" }).isEmpty && hashed == 0, "verified model: no hashing, nothing to fetch (works offline)")
place(WhisperManifest.files[0], size: 10)
try? FileManager.default.removeItem(at: wRoot.appendingPathComponent(WhisperManifest.files[1].path))
check(WhisperManifest.filesToFetch(root: wRoot, hash: fakeHash).map(\.path) == [WhisperManifest.files[0].path, WhisperManifest.files[1].path], "a damaged or deleted file is repaired")
try? FileManager.default.removeItem(at: wRoot)
check(WhisperManifest.files.allSatisfy { $0.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil && $0.size > 0 }, "every Whisper file has a SHA-256 and size")
check(WhisperManifest.files.allSatisfy { $0.url.hasPrefix("https://huggingface.co/") && $0.url.contains("/resolve/") && $0.url.range(of: "/resolve/[0-9a-f]{40}/", options: .regularExpression) != nil }, "every Whisper URL is pinned to a commit")
check(WhisperManifest.files.allSatisfy { $0.path.hasPrefix("models/") && !$0.path.contains("..") }, "Whisper files stay inside the models folder")
check(WhisperManifest.files.reduce(0) { $0 + $1.size } < 700_000_000, "Whisper download stays under 700 MB")

// MARK: Audio timeline (continuous audio for the writer)
do {
    var timeline = AudioTimeline()
    let t = { (s: Double) in CMTime(seconds: s, preferredTimescale: 48_000) }
    let first = timeline.place(arrival: t(10), count: 480, rate: 48_000)
    check(first == t(10), "first buffer keeps its time")
    let jittered = timeline.place(arrival: t(10.0093), count: 480, rate: 48_000) // 0.7 ms early: overlap
    check(jittered == CMTime(value: 480, timescale: 48_000) + t(10), "jittered buffer placed right after the previous one")
    let late = timeline.place(arrival: t(10.0215), count: 480, rate: 48_000)
    check(late == CMTime(value: 960, timescale: 48_000) + t(10), "slightly late buffer stays continuous")
    let gap = timeline.place(arrival: t(11), count: 480, rate: 48_000)
    check(gap == t(11), "a real pause restarts the timeline at the arrival time")
    check(timeline.place(arrival: t(10.5), count: 480, rate: 48_000) == nil, "a buffer from far in the past is dropped")
    var ahead = AudioTimeline()
    _ = ahead.place(arrival: t(0), count: 48_000, rate: 48_000)          // says 1 s of audio
    check(ahead.place(arrival: t(0.5), count: 480, rate: 48_000) == nil, "timeline ahead of real time: drop to catch up")
    check(ahead.place(arrival: .invalid, count: 480, rate: 48_000) == nil && ahead.place(arrival: t(2), count: 0, rate: 48_000) == nil, "invalid input dropped")
}

// MARK: Elapsed time (menu bar and REC pill)
check(Elapsed.format(0) == "0:00" && Elapsed.format(247) == "4:07" && Elapsed.format(3729) == "1:02:09" && Elapsed.format(-5) == "0:00", "elapsed time formatting")

// MARK: Separate-stream recording (parts and merge plan)
do {
    let plan = MergePlan.place([("mic-1.mp4", 0.02, 8.58), ("mic-2.mp4", 8.5, 9.5)])
    check(plan.count == 2 && plan[0] == .init(file: "mic-1.mp4", sourceStart: 0, duration: 8.58, at: 0.02), "first part placed at its start")
    check(abs(plan[1].at - 8.6) < 1e-9 && abs(plan[1].sourceStart - 0.1) < 1e-9 && abs(plan[1].duration - 9.4) < 1e-9, "an overlapping restart is trimmed, never doubled")
    let gap = MergePlan.place([("video-2.mp4", 12, 6), ("video-1.mp4", 0, 10)])
    check(gap.map(\.file) == ["video-1.mp4", "video-2.mp4"] && gap[1].at == 12, "parts sorted by start; a gap stays a gap")
    check(MergePlan.place([("a", 0, 5), ("b", 1, 3)]).count == 1, "a part entirely inside the previous one is skipped")
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mr-parts-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let manifest = PartsManifest(parts: [.init(stream: "video", file: "video-1.mp4", start: 0), .init(stream: "mic", file: "mic-2.mp4", start: 9.5)])
    try? manifest.write(to: dir)
    check((try? PartsManifest.read(from: dir)) == manifest, "parts.json round-trips")
    for bad in [#"{"version":1,"parts":[{"stream":"mic","file":"../meta.json","start":0}]}"#,
                #"{"version":1,"parts":[{"stream":"camera","file":"camera-1.mp4","start":0}]}"#,
                #"{"version":1,"parts":[{"stream":"mic","file":"mic-1.mp4","start":-1}]}"#] {
        try? Data(bad.utf8).write(to: dir.appendingPathComponent(PartsManifest.fileName))
        check((try? PartsManifest.read(from: dir)) == nil, "parts.json rejected: \(bad)")
    }
    try? FileManager.default.removeItem(at: dir)
}

// MARK: Acoustic transcript checks (echo by sound, silence)
do {
    // A "speech-like" loudness pattern: bursts of syllables.
    func speech(_ seed: Int, frames: Int) -> [Double] { (0..<frames).map { i in -30 + 20 * sin(Double(i * (seed + 3)) / 7) + Double((i * seed) % 5) } }
    let system = speech(1, frames: 600)
    let echo = Array(repeating: -90.0, count: 15) + system.prefix(585).map { $0 - 18 } // same shape, 150 ms late, quieter
    let own = speech(7, frames: 600)
    check(AudioEvidence.echoScore(mic: echo[100..<300], system: system, micStart: 100) > 0.9, "an echo of the call audio is recognized by its sound")
    check(AudioEvidence.echoScore(mic: own[100..<300], system: system, micStart: 100) < 0.6, "your own voice is not an echo")
    let lines = [Seg(start: 1, end: 3, speaker: "Others", text: "आपको 1100 रुपे"), Seg(start: 1.1, end: 3, speaker: "You", text: "आपको 1100 रुपय")]
    check(AudioEvidence.filter(lines, mic: echo, system: system).map(\.speaker) == ["Others"], "an echo line is dropped even when spelled differently")
    check(AudioEvidence.filter([Seg(start: 1, end: 3, speaker: "You", text: "Agreed")], mic: own, system: system).count == 1, "a real reply is kept")
    let silent = Array(repeating: -80.0, count: 600)
    check(AudioEvidence.filter([Seg(start: 0, end: 2, speaker: "Others", text: "Thank you.")], mic: silent, system: silent).isEmpty, "a line over silence (invented text) is dropped")
    check(AudioEvidence.filter(lines, mic: nil, system: nil).count == 2, "without audio evidence nothing is dropped")
    check(AudioEvidence.filter([Seg(start: 20, end: 21, speaker: "You", text: "अ"), Seg(start: 22, end: 23, speaker: "You", text: "-")], mic: nil, system: nil).isEmpty, "one-letter fragments dropped")
    check(AudioEvidence.filter([Seg(start: 1, end: 2, speaker: "Others", text: "好"), Seg(start: 3, end: 4, speaker: "You", text: "はい")], mic: nil, system: nil).count == 2, "a one-character CJK word is kept")
    // Ten minutes of 1024-sample buffers at 48 kHz (21.3 ms each, ~2.13 envelope frames apiece):
    // written at their exact place, the envelope stays in step with real time.
    var live: [Double] = []
    var t = 0.0
    while t < 600 { AudioEvidence.write([-30, -30, -30], at: t, into: &live); t += 1024.0 / 48_000 }
    check(abs(Double(live.count) - 600 * 100) <= 3, "live envelope doesn't drift over 10 minutes (\(live.count) frames)")
    check(AudioEvidence.envelope([Float](repeating: 0.1, count: 480), sampleRate: 48_000).count == 1 && abs(AudioEvidence.envelope([0.1, 0.1], sampleRate: 200)[0] + 20) < 0.01, "envelope in dBFS per 10 ms")
}

// MARK: Echo cancellation before recognition (mask + delay + levels)
do {
    // Speech-like loudness: syllable bursts of random length and level (not periodic, like speech).
    func speech(_ seed: UInt64, frames: Int) -> [Double] {
        var state = seed &* 6364136223846793005 &+ 1442695040888963407
        func next() -> Double { state = state &* 6364136223846793005 &+ 1442695040888963407; return Double(state >> 33) / Double(1 << 31) }
        var out: [Double] = []
        while out.count < frames {
            let level = -40 + 30 * next(), length = 5 + Int(next() * 20)
            out += (0..<length).map { _ in level + 4 * next() }
            out += Array(repeating: -55 - 10 * next(), count: 2 + Int(next() * 8)) // pause between syllables
        }
        return Array(out.prefix(frames))
    }
    var call = speech(1, frames: 1000)
    for i in 500..<1000 { call[i] = -90 }                      // the call goes quiet halfway
    let own = speech(7, frames: 1000)
    // Mic: echo of the call (12 frames late, -18 dB) for the first half, then your own voice.
    var mic = [Double](repeating: -48, count: 1000)         // a normal room: noise around -48 dBFS
    for i in 12..<500 { mic[i] = max(mic[i], call[i - 12] - 18) } // the echo, above the room noise
    for i in 500..<1000 { mic[i] = max(mic[i], own[i]) }      // your voice, over the same room noise
    let (delay, score) = AudioEvidence.bulkDelay(mic: mic, system: call)
    check(delay == 12 && score >= AudioEvidence.meetingEchoCorrelation, "speaker-to-mic delay found (\(delay) frames, r=\(score))")
    // Headphones: the mic is only your voice, sometimes over the call. No echo in the meeting.
    let headphones = (0..<1000).map { i in i % 200 < 60 ? own[i] : -48 }
    check(AudioEvidence.bulkDelay(mic: headphones, system: call).score < AudioEvidence.meetingEchoCorrelation, "no echo with headphones: nothing masked")
    let mask = AudioEvidence.echoMask(mic: mic, system: call, delay: delay)
    // While the call is speaking, its echo on the mic is masked (pauses between syllables are
    // near-silent on both and don't matter); your own voice later is never masked.
    // After the 300 ms-stretch rule (what's really silenced), the echo is covered despite the
    // gaps between the call's syllables; your own voice is never silenced.
    let silenced = AudioEvidence.stretches(mask)
    let audible = (60..<440).filter { mic[$0] > -42 }          // echo clearly above the room noise
    let echoSilenced = audible.filter { silenced[$0] }.count, ownSilenced = silenced[550..<950].filter { $0 }.count
    check(Double(echoSilenced) >= 0.9 * Double(audible.count) && ownSilenced == 0,
          "audible echo silenced with room noise (\(echoSilenced)/\(audible.count)), own voice kept (\(ownSilenced))")
    // Talking over someone: your voice on top of their echo makes the mic louder than the echo.
    var overlap = mic
    for i in 200..<300 { overlap[i] = max(overlap[i], own[i] + 10) }
    let talkOver = AudioEvidence.echoMask(mic: overlap, system: call, delay: delay)
    check(talkOver[210..<290].filter { $0 }.count < 10, "talking over the call isn't silenced")
    var quick = mic                                            // a 120 ms "yes" over the call: not bridged over
    for i in 300..<312 { quick[i] = max(quick[i], own[i] + 10, mic[i] + 15) }
    let quickSilenced = AudioEvidence.stretches(AudioEvidence.echoMask(mic: quick, system: call, delay: delay))
    check(!quickSilenced[300..<312].contains(true), "a short word over the call isn't bridged over")
    let quiet = [Double](repeating: -46, count: 200) + [Double](repeating: -75, count: 30) // a quiet mic: speech at -46 dBFS, quiet room
    let gain = AudioEvidence.normalizingGain(envelope: quiet)
    check(abs(20 * log10(Double(gain)) - 12) < 0.01, "a quiet mic is raised, up to +12 dB")
    let noisy = [Double](repeating: -46, count: 200) + [Double](repeating: -60, count: 30) // room noise at -60
    check(abs(20 * log10(Double(AudioEvidence.normalizingGain(envelope: noisy))) - 5) < 0.01, "room noise never lifted above -55 dBFS (+5 dB, not +12)")
    check(abs(20 * log10(Double(AudioEvidence.normalizingGain(envelope: [Double](repeating: -30, count: 200) + [Double](repeating: -80, count: 30), samplePeak: 0.5))) - 5.02) < 0.01,
          "gain limited by the real sample peak (-6 dBFS peak → +5 dB, not +10)")
    let choppy = (0..<200).map { $0 % 7 == 0 } + [Bool](repeating: true, count: 40) + [false, true, false]
    let runs = AudioEvidence.stretches(choppy)
    check(runs[0..<200].allSatisfy { !$0 } && runs[200..<240].allSatisfy { $0 } && !runs[241], "only whole 300 ms stretches are silenced, never slices inside speech")
    let loud = [Double](repeating: -6, count: 200)
    check(AudioEvidence.normalizingGain(envelope: loud) == 1, "loud speech isn't made louder (no clipping)")
    check(AudioEvidence.normalizingGain(envelope: [Double](repeating: -80, count: 100)) == 1, "silence isn't amplified")
}

// MARK: Share command
let shareValidator = CommandValidator()
if case .success(.share(let c)) = shareValidator.decode(#"{"cmd":"share","meetingId":"2026-11-08_10-00-00_zoom","file":"share.mp4"}"#) { check(c.file == .shareMp4, "share decoded") } else { check(false, "share accepted") }
for bad in [#"{"cmd":"share","meetingId":"../../etc","file":"share.mp4"}"#, #"{"cmd":"share","meetingId":"2026-11-08_10-00-00_zoom","file":"/etc/passwd"}"#,
            #"{"cmd":"share","meetingId":"2026-11-08_10-00-00_zoom","file":"share.mp4","path":"/tmp"}"#] {
    if case .failure = shareValidator.decode(bad) { passed += 1 } else { check(false, "share rejected: \(bad)") }
}

// MARK: Transcript cleanup
typealias Seg = Transcript.Segment
let echoed = [Seg(start: 10, end: 14, speaker: "Others", text: "We should ship the release on Friday"),
              Seg(start: 10.4, end: 14.3, speaker: "You", text: "we should ship the release on friday"),
              Seg(start: 20, end: 22, speaker: "You", text: "Agreed, I'll write the notes")]
let deEchoed = TranscriptCleanup.removeEcho(echoed)
check(deEchoed.map(\.speaker) == ["Others", "You"] && deEchoed.last?.text == "Agreed, I'll write the notes", "echo of the other side on the mic is dropped, your own words kept")
check(TranscriptCleanup.removeEcho([Seg(start: 10, end: 14, speaker: "Others", text: "ship it Friday"), Seg(start: 60, end: 64, speaker: "You", text: "ship it Friday")]).count == 2, "the same words much later are not an echo")
check(TranscriptCleanup.removeEcho([Seg(start: 1, end: 2, speaker: "You", text: "hello")]).count == 1, "no Others track: nothing removed")
let longOthers = Seg(start: 0, end: 30, speaker: "Others", text: "we think we can probably do the migration but that depends on what the team can do this week")
check(TranscriptCleanup.removeEcho([longOthers, Seg(start: 12, end: 13, speaker: "You", text: "yes we can do that")]).count == 2, "a real reply sharing common words with a long Others line is kept")
check(TranscriptCleanup.removeEcho([longOthers, Seg(start: 12, end: 13, speaker: "You", text: "I")]).count == 2, "a one-word reply is never treated as echo")
check(TranscriptCleanup.removeEcho([longOthers, Seg(start: 20, end: 24, speaker: "You", text: "depends on what the team can do")]).count == 1, "an in-order run of their words inside a long line is echo")
let merged = TranscriptCleanup.merge([Seg(start: 0, end: 2, speaker: "Others", text: "So the plan"), Seg(start: 2.5, end: 4, speaker: "Others", text: "is to ship."),
                                      Seg(start: 4.2, end: 5, speaker: "You", text: "Great."), Seg(start: 9, end: 10, speaker: "You", text: "Next.")])
check(merged.map(\.text) == ["So the plan is to ship.", "Great.", "Next."] && merged[0].end == 4, "fragments merge on short pauses, not across speakers or long pauses")

// MARK: AgentConfig
let home = FileManager.default.temporaryDirectory.appendingPathComponent("mr-checks-\(UUID().uuidString)").path
try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
check(AgentConfig.load(home: home) == .failure(.missing("\(home)/agent.json")), "missing config")
FileManager.default.createFile(atPath: "\(home)/agent.json", contents: Data("{".utf8))
check(AgentConfig.load(home: home) == .failure(.unreadable("\(home)/agent.json")), "corrupt config")
let config = AgentConfig(nodePath: "/bin/sh", daemonEntry: "/x/index.ts", webDist: "/x/dist", meetingsDir: "/Users/me/Meetings", home: home)
FileManager.default.createFile(atPath: "\(home)/agent.json", contents: try! JSONEncoder().encode(config))
check(AgentConfig.load(home: home) == .success(config), "valid config loads")
let badNode = AgentConfig(nodePath: "/nonexistent/node", daemonEntry: "/x/index.ts", webDist: "/x", meetingsDir: "/m", home: home)
FileManager.default.createFile(atPath: "\(home)/agent.json", contents: try! JSONEncoder().encode(badNode))
check(AgentConfig.load(home: home) == .failure(.notExecutable("/nonexistent/node")), "missing node binary reported")
try? FileManager.default.removeItem(atPath: home)

// Audio file boundary: levels() and writeCleaned() on a real 16 kHz file (1 s tone at 0.1).
do {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("agentcore-audio-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1)!
    let source = dir.appendingPathComponent("in.caf"), target = dir.appendingPathComponent("out.caf")
    do {
        let file = try AVAudioFile(forWriting: source, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 16_000)!
        buffer.frameLength = 16_000
        for i in 0..<16_000 { buffer.floatChannelData![0][i] = 0.1 * sin(Float(i) * 0.3) }
        try file.write(from: buffer)
    }
    let levels = AudioFiles.levels(source)
    check(levels?.envelope.count == 100 && levels?.peaks.count == 100 && abs((levels?.peaks[5] ?? 0) - 0.1) < 0.001,
          "levels: one envelope frame and one peak per 10 ms")
    let silence = (0..<100).map { (20..<60).contains($0) }
    try AudioFiles.writeCleaned(from: source, to: target, gain: 20, silence: silence)
    let out = try AVAudioFile(forReading: target, commonFormat: .pcmFormatFloat32, interleaved: false)
    let read = AVAudioPCMBuffer(pcmFormat: out.processingFormat, frameCapacity: 16_000)!
    var x: [Float] = []
    while out.framePosition < out.length {
        try out.read(into: read)
        x += UnsafeBufferPointer(start: read.floatChannelData![0], count: Int(read.frameLength))
    }
    check(x.count == 16_000 && out.length == 16_000, "cleaned track keeps its length (timeline intact: \(x.count), \(out.length))")
    check(x[3_200..<9_600].allSatisfy { $0 == 0 }, "silenced frames are fully silent")
    check(x.allSatisfy { abs($0) <= 1 } && x[1_000..<1_100].contains { abs($0) > 0.99 }, "gain applied and clamped to ±1")
    check(abs(x[3_199]) < 0.05 && abs(x[9_600]) < 0.05 && x[9_664..<9_760].contains { abs($0) > 0.5 },
          "2 ms fades at the cut, full level right after")
} catch { check(false, "audio file boundary: \(error)") }

print(failures == 0 ? "AgentCoreChecks OK (\(passed) checks)" : "AgentCoreChecks FAILED: \(failures) of \(passed + failures)")
exit(failures == 0 ? 0 : 1)
