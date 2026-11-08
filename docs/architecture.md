# Architecture

```
login (LaunchAgent, KeepAlive)
  └── Meeting Recorder.app (Swift, menu bar)       capture (ScreenCaptureKit), mic detection, permissions
        └── node daemon (apps/daemon, Fastify)     state machine, detection rules, storage, recovery, API
              └── dashboard (apps/web, React + Tailwind/shadcn) served on 127.0.0.1, shown in the app's own window
```

The agent is the parent so macOS attributes Screen Recording / Microphone permission to "Meeting Recorder". They talk NDJSON over the daemon's stdin/stdout ([protocol.md](protocol.md)). The daemon exits when stdin closes, so it can never be orphaned.

## Daemon layering (`apps/daemon/src`)

| Layer | Folder | Rule |
|---|---|---|
| Routes | `routes/` | URL + JSON schema → controller. Every input validated; unknown fields rejected. |
| Controllers | `controllers/` | Thin: read the request, call a service, shape the reply. |
| Services | `services/` | All behaviour. Throw `HttpError`s (`lib/errors.ts`) for 404/409. |
| Repositories | `repositories/` | Filesystem only. No business rules. |
| Models | `models/` | Pure functions and types (ids, sanitizing, parsing, schemas). |
| Agent | `agent/` | Protocol channel + routing of agent events to services. |
| Composition | `container.ts`, `app.ts`, `index.ts` | Wiring (manual dependency injection), Fastify setup, process entry. |

## Recording state machine (`services/RecordingService.ts`)

The only place recorder state changes. Every trigger (detection, menu bar, dashboard, sleep, disk guard, agent) goes through one serialized `dispatch`, so side effects never interleave.

```
idle ──start──▶ starting ──agentStarted──▶ recording ──stop──▶ stopping ──agentStopped──▶ idle
  ▲                │ agentError / 10 s timeout:                 │ agentError / 20 s timeout:
  └────────────────┘ delete empty folder, warn                  └ recover the file, warn ──▶ idle
idle ──adopt (hello.activeMeetingId)──▶ recording            stop while starting: applied after agentStarted
```

## Storage (no database)

```
~/Meetings/2026-11-08_14-30-05_zoom/
  recording.mp4          fragmented MP4 written by the agent (H.264 + 2 AAC tracks: system, mic)
  meta.json              Meeting, written atomically (temp file + rename)
  recording.state.json   only while recording; a leftover one means the recording was interrupted
```

An in-memory index (sorted ids, newest first) is built at startup (10,000 meetings in ~0.7 s) and kept in sync on every write; `fs.watch` drops folders deleted in Finder. The list API uses cursor pagination (binary search), so pages stay stable while new meetings arrive. Load test (`npm run load`): 10,000 meetings, ~20k req/s, p97.5 and p99 under 1 ms; the gate fails above p97.5 = 20 ms.

## Crash recovery (`services/RecoveryService.ts`, `lib/mp4.ts`)

If the recorder's writer fails (reported as an `error` event), the daemon recovers the file at once, losing at most the last unsaved 5 s chunk. When that works, the meeting is marked "recovered" and shows a note; the raw AVFoundation error goes to the daemon log only, not to the banner. The banner appears only when nothing could be saved. The agent logs one diagnostics line on any writer failure: the failing step (append or finishWriting), and per track the samples written, last timestamp, samples dropped for not moving forward, and format changes.

AVAssetWriter writes each fragment's data first, then the `moof` describing it, keeping in-progress data in a size-0 `mdat`. Recovery walks only box headers and `moof`s (never the video data), truncates after the last complete fragment, and sums durations (fragments carry no `tfdt`). It runs **after** the agent's `hello` and skips the meeting the agent reports as still recording, so a daemon restart never touches a live file. Verified against real recordings killed with `kill -9`.

## Meeting detection (`services/DetectionService.ts`, `detection-rules.json`)

- Native apps (Zoom, Teams, Webex, Slack, FaceTime): the app using the mic is enough.
- Browsers: their mic helper process **and** a window whose title matches a meeting pattern (e.g. `Meet - `), so dictation or voice chat in a browser doesn't start a recording.
- Hysteresis: start after the match holds 3 s; stop an auto-started recording after it's gone 15 s. Manual recordings are never auto-stopped.
- Disabled when the agent's protocol version differs.
- ScreenCaptureKit's `captureMicrophone` reads the mic through the system service `com.apple.replayd`, not our process, so the agent ignores `replayd` as a mic user. This was verified with `MeetingRecorderAgent --mic-probe`, a diagnostic that prints which processes are using a mic.

## Security (local only)

- Fastify binds `127.0.0.1` only. `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding).
- `/api/*` needs either the per-launch 256-bit token as `Authorization: Bearer` (CLI, read from `~/.meeting-recorder/runtime.json`, mode 0600), or a dashboard session cookie that the dashboard gets by POSTing the token from its URL fragment to `/api/session`.
- Cookies are scoped by host, not port, so other servers on 127.0.0.1 receive them and `SameSite` treats every 127.0.0.1 port as the same site. The cookie therefore:
  - holds a separate random session id (never the token);
  - is named per port (`mr_session_<port>`);
  - requires an `Origin: http://127.0.0.1:<port>` header on cookie-authenticated `POST`/`PUT`/`DELETE` (CSRF protection against pages on other local ports).
- The auth check uses the route the router matched, not the raw URL, so percent-encoded paths can't skip it.
- No CORS headers. Strict CSP (`default-src 'self'`), `X-Frame-Options: DENY`, no-referrer.
- No outbound network: `test/egress.test.ts` fails if booting and using the daemon connects anywhere but loopback.
- Commands to the agent are validated against the schema before sending (e.g. `openUrl` only to the local dashboard).

## Native agent (`native/macos`)

| Part | Job |
|---|---|
| `AppController` | Wires everything; forwards facts to the daemon and executes its commands. SIGTERM (launchd/logout) terminates in order so an active recording is finalized. |
| `Recorder` | ScreenCaptureKit: display, system audio and mic (`captureMicrophone`, on one clock) into AVAssetWriter: H.264 with a keyframe every 5 s, 2 AAC tracks, a fragment every 5 s. Starts on the first *fresh* complete frame and paces frames itself (the T1 spike showed `minimumFrameInterval` isn't honored). The slot is reserved before async setup, so a quick stop is honored and a second start is refused. |
| `MicMonitor` | CoreAudio process objects (macOS 14+): which other apps are using a mic, event-driven through property listeners, which are removed when a process goes away. Window titles are re-read every 2 s only while some app uses a mic. A generation counter stops a slow title lookup from publishing a stale snapshot. |
| `DaemonHost` | Spawns the pinned Node daemon, validates every command (`CommandValidator`: schema rules Codable can't express, e.g. start paths must be `<Meetings>/<id>/recording.mp4`), and restarts it with backoff (1 to 30 s). |
| `Permissions`, `PowerMonitor` | Screen Recording preflight at launch, hourly and on wake. Sleep, wake, AC and battery. |
| `DashboardWindow` | The dashboard in a native `WKWebView` window.<br>• Only the local 127.0.0.1 dashboard loads inside it; other links open in the browser.<br>• Uses non-persistent web storage.<br>• Releases WebKit on close.<br>• Opens when the user opens the app; the login item passes `--background` so login stays quiet.<br>• No ⌘Q, so closing the window never stops the recorder. |
| `MeetingRecorderTranscriber` | Separate executable; see below. |
| `AgentCore` | Pure logic (wire format, validator, capture math, transcript format), checked by `swift run AgentCoreChecks`. The Command Line Tools ship without XCTest. |

## Live transcript (`LiveTranscriber.swift`, macOS 26)

```
daemon start {…, liveLocale} ─▶ agent: SpeechAnalyzer + SpeechTranscriber ×2 ("Others" = system audio, "You" = mic)
  same retimed audio the writer gets ─▶ own utility queue: convert to the analyzer format ─▶ AnalyzerInput
  final results ─▶ {type:"transcript"} events ─▶ daemon ─▶ {type:"liveTranscript"} SSE ─▶ dashboard card
  stop ─▶ writer finishes first (the video is safe) ─▶ live finish, ≤10 s ─▶ transcript.json ─▶ "stopped"
daemon: Apple engine ─▶ transcript "done" at once (summary follows) · Whisper ─▶ lines shown, then the Whisper job
GET /api/meetings/:id/live ─▶ lines so far (dashboard opened or reloaded mid-meeting); in memory, 2 meetings × 5,000 lines
```

transcript.json is written only when the live transcript covers the whole meeting: the analyzers start alongside capture (so the first seconds are heard), and a track error or a finish slower than 10 s means nothing is written and the after-meeting job runs instead. Lines are accepted only for the meeting being recorded.

Best effort: if the language or the model isn't available yet (it's requested for next time), the meeting is transcribed after it ends as before; a live failure never touches the recording.

## Recorder robustness

- Audio is placed on a continuous timeline (`AgentCore/AudioTimeline.swift`): time = anchor + samples so far / rate; drift within ±100 ms is absorbed, a real pause restarts the timeline, a buffer far in the past is dropped. A buffer is copied only when its time changes (`AudioCopy.swift`, which also logs each input's first buffer).
- **Separate-stream recording** (`AgentCore/RecordingParts.swift`, `StreamWriter.swift`, `Merger.swift`, `services/MergeService.ts`). Writing video and both audio tracks into one file while recording failed intermittently inside AVAssetWriter (-11800 / -16341 at a 5 s fragment boundary) and took the whole meeting with it. Now each stream has its own writer and crash-safe fragmented part (`video-1.mp4`, `system-1.mp4`, `mic-1.mp4`), all on the capture's one clock, with their start times in `parts.json`. A writer that fails restarts only its own stream as the next part at the next sample (at most 5 times a minute per stream); the other streams don't notice. After the meeting (and in crash recovery) the daemon trims each part's unfinished tail and the helper merges them (`--merge`, passthrough, no re-encode: 10 minutes took 0.11 s in testing) into `recording.mp4`, then the parts are removed. The recorder goes idle the moment the agent stops and the merge runs in the background, with the meeting kept busy so crash recovery can't merge it at the same time. Only the parts the helper reports using are removed. A failed merge keeps every part and recovery retries; after 3 failed attempts (or with no helper) the meeting is finalized as recovered with its parts kept, so it never blocks recovery. A failed writer waits 1 s before its next part, and a part is listed in parts.json before anything is written to it.
- Why: Otter (1.12.0) and Granola (7.749.1), inspected statically, capture system audio with Chromium's loopback (`setDisplayMediaRequestHandler` → `audio: 'loopback'`, Core Audio tap or ScreenCaptureKit underneath, via the `electron-audio-loopback` approach) and the mic with `getUserMedia({echoCancellation})`, batch raw PCM in AudioWorklets and stream it for transcription. Neither writes video, and neither muxes while recording.
- Still in place as a last resort: if every stream keeps failing, the recording ends and an auto-started one continues in a new "… (continued)" recording (`DetectionService`, up to 3 per meeting); a manual one does too (`RecordingService.continueManual`). A user's Stop is never undone.
- A floating REC pill (`RecordingIndicator.swift`) and a timer next to the menu-bar icon show recording is on; the app's own windows are excluded from capture.

## Transcription and summaries (`services/TranscriptionService.ts` + `MeetingRecorderTranscriber`)

Two kinds of job run one at a time, newest meeting first, under the same rules (not recording, battery is fine, watchdog, 3 retries, cancelled when a recording starts):

1. **Transcribe:** described below.
2. **Summarize:** `MeetingRecorderTranscriber --summarize <dir>`, run only after the transcript is done.
   - Apple's on-device Foundation Models write a structured summary (overview, key points, decisions, action items).
   - It uses `DynamicGenerationSchema`, because the `@Generable` macro needs full Xcode.
   - The model's context is about 4k tokens, so long transcripts are summarized map-reduce style: notes per chunk, then a summary of the notes.
   - Measured: a 12 s meeting transcribed and summarized in 8 s end to end; a 15.9k-character transcript summarized in 20 s (2 parts); about 20 MB of memory in our process.
   - Exit code 3 (Apple Intelligence off) disables only summaries; transcripts keep running.
   - Exit codes: 0 done · 3 unavailable (blocked 30 min, cleared by a settings change) · 5 model still downloading (queued, retried after 10 min) · 6 the model refused this transcript (failed at once, reason saved in `summaryError`) · anything else retries up to 3 times.
   - Each meeting has its own `summary.json` / `summary.md`. Re-transcribing a meeting re-queues its summary, so it never describes an old transcript.
   - Old outputs are kept until a new file replaces them (only a file written after the job started counts), so a failed redo never loses a good transcript or summary.
   - "queued" is only set when the user asks (or for a retry), and it survives restarts even when the automatic setting is off.
   - Very long meetings are reduced in rounds until the notes fit one window. If a round stops shrinking, the job fails with a clear reason rather than summarizing only part of the meeting.

```
meeting finalized ─▶ queue (derived from meta.json: transcript none|queued; newest first)
    gates: enabled · recorder idle · on AC power · transcriber present · one job at a time
      └─▶ MeetingRecorderTranscriber recording.mp4 <dir>
            per audio track (system = "Others", mic = "You"): AVAssetReader → 16 kHz mono PCM → SpeechAnalyzer + SpeechTranscriber (--locale from Settings)
            (PCM laid out on the movie timeline: late track starts, gaps and unreadable buffers become silence, so times match the video)
            → TranscriptCleanup: drop mic echo of "Others" (overlapping ±1.5 s, an in-order run of ≥3 words and ≥60% of the line), merge same-speaker fragments (gap ≤1.2 s)
            → transcript.json + transcript.vtt (atomic writes) ; stdout {"percent":n}
    recording starts / unplugged ─▶ SIGTERM, requeue · exit 3 ─▶ unavailable (macOS < 26) · 3 failures ─▶ failed (Retry)
```

Apple's on-device SpeechTranscriber (macOS 26) replaced the planned whisper.cpp:

- no CMake, prebuilt binary or 150 MB model to manage
- the model runs in a system process, so our memory budget is untouched
- it's built for long-form audio

Measured: 11 s of speech transcribed in about 1 s, with our process using 0.05 s of CPU. On macOS 15, Apple's engine isn't available; the Whisper engine is. The job slot is reserved synchronously, so two triggers can't start two jobs.

### Open-model engines (`MeetingRecorderTranscriber/OpenModels.swift`)

Optional, chosen in Settings (`transcription.engine`, `transcription.summaryEngine`); the daemon passes `--engine whisper|qwen --models ~/.meeting-recorder/models`.

```
--engine whisper  WhisperKit 0.18.0 (exact SwiftPM pin) runs argmaxinc/whisperkit-coreml large-v3 turbo 632 MB
                  downloaded by us, not WhisperKit: 25 files from pinned commits, each SHA-256 checked
                  (AgentCore/WhisperManifest.swift, built from Hugging Face's LFS/git records), tokenizer included
                  same per-track 16 kHz PCM + TranscriptCleanup; VAD chunking, 1 decoder worker
--engine qwen     llama.cpp b12202 prebuilt (SHA-256 pinned) + Qwen3-1.7B Q8_0 GGUF (revision + SHA-256 pinned)
                  llama-completion: 6k context, q8_0 KV cache, ≤4 threads, JSON-schema-constrained output
                  same map-reduce as Apple's model (SummaryModel protocol), 3k-token chunks (our estimate can undercount Qwen tokens ~30%)
```

Resource rules:
- Every job (both engines, and share copies) is spawned through `taskpolicy -b`: background QoS, so the work goes to the efficiency cores at low I/O priority. Jobs still run only when nothing is being recorded (on battery too: they no longer wait for a charger).
- Each job leads its own process group and is stopped as a group, so llama.cpp never outlives a cancelled or killed summary.
- Once verified, models are used straight from disk with no network call (works offline). After that a run only checks each Whisper file's size (a stat), so a deleted or damaged file is fetched again and verified. The Whisper tokenizer is kept in the same folder (WhisperKit's default would be ~/Documents).
- A download that fails on the network exits 5 (queued, tried again in 10 minutes, retries not used up). A file that doesn't match its pinned SHA-256 is deleted and exits 6 (failed, reason shown).
- Whisper has its own language list (`whisperLanguages`, ~100 codes), so a fixed language can be chosen on any macOS.
- Downloads happen inside the job, once. A file that fails its SHA-256 check is deleted, never used. While downloading, `{"status":"downloading"}` lines restart the daemon's time limit.
- `--capabilities` reports why an engine can't run here (Intel Mac; less than 8 GB for Qwen), and Settings disables that choice with the reason.

Measured (M2, 16 GB):

| | Memory | Time |
|---|---|---|
| Whisper, warm | ~290 MB | 97 s of speech in 26 s |
| Whisper, first run | ~620 MB | ~5 min, once (download + Core ML compile) |
| Qwen | 1.2–2.4 GB peak, mostly the memory-mapped model (reclaimable) | ~2k tokens summarized in 16 s |

### Downloading models ahead of time (`services/ModelService.ts`)

```
GET  /api/models                   {whisper, qwen}: missing | downloading(percent, what) | ready | failed(error) | unavailable(reason)
                                   from `--model-status` (file checks only: no hashing, no network)
POST /api/models/:engine/cancel    stops it (verified files kept)
POST /api/models/:engine/download  ─▶ taskpolicy -c utility MeetingRecorderTranscriber --prepare <engine> --models <dir>
                                   progress lines ─▶ {type:"model"} SSE ─▶ Settings progress bar
```

- `POST /api/models/:engine/cancel` stops the download's process group and goes back to `missing`. Each file is moved into place only after its SHA-256 check, so finished files stay and the next download resumes from them.
- One download per engine; a second click joins it. Jobs needing that model wait (pump skips them) and start when it's ready.
- Whisper's prepare step also loads the model once, which compiles it for the Neural Engine (the slow first-run step), so the first meeting is fast.
- Utility priority (not background): the user is watching the progress bar, but it still yields to anything interactive.

## Sharing (`services/ShareService.ts`, `Exporter.swift`, `DashboardWindow.share`)

```
POST /api/meetings/:id/share {what: video|original|summary}
  original/summary ─▶ agent {cmd:"share", meetingId, file}  ─▶ NSSharingServicePicker on the dashboard window
  video ─▶ share.mp4 fresh (newer than recording.mp4)? share it
        └▶ else spawn (taskpolicy -b) MeetingRecorderTranscriber --export recording.mp4 share.mp4
             AVAssetReader (video + AVAssetReaderAudioMixOutput: both tracks mixed) ─▶ AVAssetWriter
             H.264 ≤1280×720 1.2 Mbps (hardware) + AAC 128 kbps stereo; .part then rename
           {type:"share", state, percent} SSE events ─▶ dashboard progress; on success, the share sheet
```

- One copy at a time (reserved before any await). Another meeting gets 409. Deleting the meeting stops its copy. A recording starting stops it (a re-encode must never compete with capture), and no copy starts while recording; the original can still be shared.
- The share command has no path. The agent builds `<meetings>/<id>/<file>` itself from a validated id and a fixed file enum, so the daemon can't make it share anything else.
- Measured: a 10 s 1080p test recording copied in 1.5 s with 46 MB of memory.

## Installer and updates (`scripts/`)

`install.sh` (what `curl | bash` runs) only checks prerequisites, clones the repo and hands over to the versioned `scripts/meeting-recorder` CLI:

- **Node:** pinned and SHA-256 verified, in `~/.meeting-recorder/runtime`.
- **App bundle:** built and signed on the machine, with a local self-signed identity when you chose one (so TCC permissions survive rebuilds), otherwise ad-hoc. No hardened runtime.
- **Startup:** a LaunchAgent with `KeepAlive` on crash only.
- **`update` is atomic:**
  1. clone the new version into a staging folder and build it there; the live install keeps running;
  2. `launchctl bootout`;
  3. swap the app folder and bundle;
  4. `launchctl bootstrap`.

  Any failure after the bootout restores the previous version (`set -E` + `ERR` trap).
- **Refusals:** `update`, `repair` and `uninstall` refuse while a meeting is being recorded.
- **Tests:** bats with stubbed system tools, plus real-git update tests against a local bare "remote".
