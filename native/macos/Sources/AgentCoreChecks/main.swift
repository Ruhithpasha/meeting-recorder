// Logic checks for AgentCore. The Command Line Tools ship without XCTest/swift-testing, so this is
// a plain executable: `swift run AgentCoreChecks` (exit 1 on any failure). It decodes the SAME
// protocol fixtures as the TypeScript tests, so both sides agree on what is valid.
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
check(OpenModelText.cleanWhisper("<|startoftranscript|><|en|><|0.00|> Good  morning.<|3.52|>") == "Good morning.", "Whisper special tokens stripped")
let qwenOut = #"{"overview":"Sync.","keyPoints":["a"],"decisions":[],"actionItems":["Priya: docs"]} [end of text]"#
check(OpenModelText.parseSummary(qwenOut) == MeetingSummary(overview: "Sync.", keyPoints: ["a"], decisions: [], actionItems: ["Priya: docs"]), "Qwen JSON summary parsed despite trailing text")
check(OpenModelText.parseSummary("no json") == nil && OpenModelText.parseSummary(#"{"keyPoints":[]}"#) == nil, "bad summary output rejected")
check(OpenModelText.parseNotes(#"{"points":["one","two"]}"#) == "- one\n- two", "Qwen notes parsed")
check(OpenModelText.chatPrompt(system: "S", user: "U").hasSuffix("<think>\n\n</think>\n\n") && OpenModelText.chatPrompt(system: "S", user: "U").contains("U /no_think"), "Qwen prompt has thinking off")

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

print(failures == 0 ? "AgentCoreChecks OK (\(passed) checks)" : "AgentCoreChecks FAILED: \(failures) of \(passed + failures)")
exit(failures == 0 ? 0 : 1)
