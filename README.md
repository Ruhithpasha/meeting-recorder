# Meeting Recorder

Free, open-source, **local-only** meeting recorder for macOS. It sits in your menu bar, notices when a Zoom, Teams, Google Meet, Webex, Slack huddle or FaceTime call starts, and records your screen plus **both sides of the audio** (your mic and everyone else) to `~/Meetings`. It can also transcribe each meeting and write a **summary** (key points, decisions, action items) on your Mac, labelling who spoke ("You" / "Others"). Nothing leaves your Mac: no account, no cloud, no telemetry.

## Install

Requires **macOS 15 or later** and the **Xcode Command Line Tools** (the installer offers to install them). Transcription needs macOS 26 or later.

```bash
curl -fsSL https://raw.githubusercontent.com/Ruhithpasha/meeting-recorder/main/scripts/install.sh | bash
```

The installer:

1. Clones this repo to `~/.meeting-recorder/app`.
2. Downloads a pinned Node.js runtime, checking its SHA-256 against the value committed in [`scripts/node-version.txt`](scripts/node-version.txt). It never uses or changes your own Node.
3. Builds the dashboard and the menu-bar app **on your Mac**, so macOS shows no "unidentified developer" warning.
4. Optionally creates a local code-signing certificate. macOS asks for your password twice. This keeps Screen Recording and Microphone permission across updates.
5. Starts Meeting Recorder now and at every login.

After installing, macOS asks for **Screen & System Audio Recording** and **Microphone** access for "Meeting Recorder". Allow both, then quit Meeting Recorder from the menu bar and reopen it once so the Screen Recording permission applies.

### Updating

```bash
meeting-recorder update
```

This downloads the latest version and builds it next to your current one. It only switches over if everything succeeded, so a failed update leaves your current version running. It won't run while a meeting is being recorded. Your recordings, settings and permissions are kept. If the command isn't found, open a new Terminal window, or run `~/.meeting-recorder/bin/meeting-recorder update`.

### Commands

```bash
meeting-recorder status      # is it recording?
meeting-recorder open        # open the dashboard (also in the menu bar)
meeting-recorder update      # latest version; if anything fails, your current version keeps running
meeting-recorder repair      # fix a broken install (e.g. after moving things around)
meeting-recorder logs        # follow the logs
meeting-recorder uninstall   # remove the app; your recordings in ~/Meetings are kept
```

## Using it

- **You decide when it records.** Join a call and after about 3 seconds a small floating pill asks: **"Google Meet detected · Record"**. Nothing is recorded until you press Record. (Prefer hands-off? Turn on "Record meetings automatically" in Settings.)
- **While recording**, the pill shows **REC 12:34** with a **Stop** button, and the menu-bar icon turns red with a timer. Drag the pill anywhere; click it to open the dashboard; it isn't in the recording and stays off full-screen apps. About 15 seconds after the call ends, a recording started from the prompt stops by itself.
- **Built not to drop a meeting:** video, the call's audio and your mic are each recorded to their own file and joined into one `recording.mp4` when the meeting ends (in seconds, without re-encoding). If macOS's file writer fails on one of them, only that one restarts, straight away; the others keep recording.
- **Start and stop any time:** the dashboard's Start/Stop button, menu bar → Start/Stop Recording (⌘R), or the pill.
- **Stopping early:** if you stop an automatic recording during a call, it won't restart until that call ends.
- **Browser calls (Meet, Teams web):** these need the meeting tab to be the visible tab, because the app checks the window title. Joining with your mic muted at the OS level isn't detected; start those manually.
- **Dashboard:** opens in the app's own window (no browser, nothing hosted). Get there by opening Meeting Recorder from Finder, Spotlight or Launchpad, choosing menu bar → Open Dashboard, or running `meeting-recorder open`.
  - Meetings are grouped by day and searchable.
  - Plays recordings with seeking; transcripts are clickable to jump to a moment.
  - Show in Finder, and delete to the Trash.
  - Settings (bottom of the sidebar): quality (720p or 1080p, at 30 or 15 fps), auto-record, transcription and summary engines, the meeting language, extra apps.
  - Share: send the video (a smaller copy), the original or the summary through the Mac's share menu.
  - Follows your Mac's light or dark appearance. A live waveform shows while recording; the menu-bar icon is the same waveform, red and moving while recording.
  - Closing the window (⌘W) doesn't stop recording. ⌘Q, Dock → Quit, or "Quit Meeting Recorder" in the menu bar quits; if a meeting is being recorded it asks first, then saves the recording before quitting. It starts again at your next login, or when you open it.
- **Files:** one folder per meeting, for example `~/Meetings/2026-11-08_14-30-05_zoom/`:
  - `recording.mp4`: H.264 video plus two AAC tracks (others, you). It plays in QuickTime.
  - While recording, `video-1.mp4`, `system-1.mp4`, `mic-1.mp4` and `parts.json` (each stream on its own); they're joined into `recording.mp4` when the meeting ends.
  - `meta.json`: the meeting's details.
  - `transcript.json` and `transcript.vtt`: the transcript, once it exists.
  - `summary.md` and `summary.json`: the summary, once it exists.
  - `share.mp4`: the smaller copy, if you shared the video.

### Transcripts and summaries

**Live:** on macOS 26 the meeting is transcribed while it happens (Apple's on-device model). The dashboard shows each line as people speak, and the transcript is ready the moment the meeting ends. Otherwise, after a meeting is saved, Meeting Recorder transcribes it with Apple's on-device speech engine. It then writes a **summary** (overview, key points, decisions, action items with owners) with Apple's on-device language model.

- After-meeting jobs (Whisper, summaries) run when you're not recording, at low priority, on battery too.
- Nothing leaves your Mac.
- The summary appears above the transcript in the dashboard, with a **Copy** button (Markdown), and is saved as `summary.md` next to the recording.
- "You" and "Others" come from the two separate audio tracks, so the labels are exact rather than guessed.
- Requirements: transcripts need macOS 26. Summaries also need **Apple Intelligence** turned on (System Settings → Apple Intelligence & Siri).
- Long meetings are summarized in parts that are then combined, because the on-device model reads about 15 minutes of talk at a time.
- **Every meeting gets its own summary**, saved in its own folder. Use **Summarize now** on a meeting to make one right away, or **Retry** if it failed (the reason is shown).
- Transcription quality:
  - Audio is extracted losslessly (16 kHz PCM) before recognition, and recordings use higher-bitrate audio (160 kbps for others, 96 kbps for you).
  - **Echo cancellation before transcription:** the call's own audio is the reference. The app finds the speaker-to-mic delay, silences the stretches where your mic only repeats the call, and evens out quiet and loud tracks, so the speech model never hears the echo. With headphones (no echo) nothing is removed. This runs in the after-meeting transcription; the live transcript drops echoed lines instead. (Apple's voice processing can't do this: it only cancels sound the app itself plays, and Chrome plays the call.)
  - With "Meeting language" on automatic, the language is detected once from the call audio and used for both tracks.
  - Echo is also removed line by line, by sound rather than words: when your mic hears the call through your speakers, those "You" lines rise and fall with the call audio and are dropped, whatever the language or spelling.
  - Lines over silence (the "Thank you." a speech model invents when nobody speaks) and one-letter fragments are dropped.
  - Short fragments from the same speaker are merged into readable sentences.
  - Pick the **meeting language** in Settings (for example English (India) or Hindi) if it differs from your Mac's language.
- Turn either off in Settings.

### Open models (optional)

In Settings you can swap Apple's models for open models from Hugging Face. Pick one and press **Download now** to download it with a progress bar, or let it download before the first meeting that needs it. Whisper is also prepared for your Mac's chip after downloading (a few minutes, once). **Cancel** stops a download; what's already downloaded is kept, so the next download carries on, and meetings that need the model wait until you download it. Each downloads **once** into `~/.meeting-recorder/models` (pinned version, checked against its fingerprint), then runs only on your Mac, at background priority, when you're not recording. No meeting content is ever uploaded.

| Engine | For | Download | Measured on an M2 (16 GB) |
|---|---|---|---|
| Apple (default) | transcripts (macOS 26), summaries (Apple Intelligence) | none | |
| **Whisper large-v3 turbo** (WhisperKit, Core ML) | transcripts: better with accents and mixed languages; works without macOS 26 | 632 MB | ~290 MB memory; 97 s of speech in 26 s (Neural Engine). The first run takes a few minutes once, to prepare the model. |
| **Qwen3 1.7B** (llama.cpp) | summaries without Apple Intelligence; reads about 8× more text at a time | 1.8 GB + 17 MB | 1.2–2.4 GB at peak, most of it the model file, which macOS can reclaim; a long meeting summarized in about 30 s. Needs Apple silicon and 8 GB+ of memory. |

Both need a Mac with Apple silicon. With "Meeting language" on automatic, Whisper detects the language itself.

### Sharing a meeting

Each meeting has a **Share** menu that opens the Mac's share sheet (AirDrop, Mail, Messages, and any app that accepts files). Nothing is uploaded by Meeting Recorder.

- **Video:** a smaller 720p copy (about 0.6 GB per hour) with everyone in one audio track, so it sounds right in any player. It's made the first time you share (with the Mac's hardware encoder, at background priority), saved as `share.mp4`, and reused after that.
- **Original recording:** full quality. It has two audio tracks (others, you); QuickTime plays both, some players only the first.
- **Summary:** `summary.md`.

Anyone you share a recording with gets everyone's voices and your screen: check that's OK with the people on the call.

## Recording consent

Laws in many places require **everyone on a call to agree** before it is recorded. Meeting Recorder shows a red menu-bar icon and a notification whenever it records, and it records your **whole display** by default, so anything visible on screen is saved. You are responsible for getting consent and for what you keep.

## Privacy and resources

- **Local only:**
  - The daemon listens only on `127.0.0.1`.
  - The recorder contains no networking code.
  - The only downloads are the open models, and only if you choose one in Settings: once, from Hugging Face and GitHub, checked against pinned fingerprints. Recordings, transcripts and summaries are never uploaded.
  - A test fails if the daemon ever connects anywhere but loopback.
  - There's no telemetry or auto-updater: updates happen only when you run `meeting-recorder update`.
- **Lightweight:**
  - The menu-bar app plus the background service use roughly 15–60 MB while recording.
  - Recordings default to 720p at 30 fps with hardware encoding, about 1.1 GB per hour. 1080p 30 fps is about 2.2 GB per hour. The 15 fps options use about 40% less (720p 15 fps: about 0.7 GB per hour; 1080p 15 fps: about 1.4 GB per hour).
  - If the app crashes or the Mac loses power, the recording is kept up to the last 5 seconds.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Menu bar shows ⚠️ "Screen Recording permission is off" | System Settings → Privacy & Security → Screen & System Audio Recording → enable Meeting Recorder (macOS re-asks every so often). |
| A call isn't detected | Check that the call app is listed in Settings, or add its bundle id under "Other apps". `~/Applications/Meeting\ Recorder.app/Contents/MacOS/MeetingRecorderAgent --mic-probe 20` shows which apps are using the mic. |
| "Run: meeting-recorder repair" in the menu | Run it. It re-verifies the Node runtime and the config. |
| Anything else | `meeting-recorder logs`. The logs never contain meeting content. |

## Development

Requires Node 22.18+ (TypeScript runs directly via Node's type stripping, with no build step) and the Xcode Command Line Tools.

```bash
npm ci
npm test                 # protocol freshness + shared, daemon, web tests
npm run typecheck
npm run load             # 10,000-meeting load test
npm run test:sh          # installer/CLI tests (bats)
npm run lint:sh          # shellcheck
swift run --package-path native/macos AgentCoreChecks
npm run gen:protocol     # after editing packages/shared/protocol.schema.json
```

| Path | What |
|---|---|
| `packages/shared` | Protocol schema (single source of truth), generated TS/Swift types, API types |
| `apps/daemon` | Fastify daemon: routes → controllers → services → repositories → models |
| `apps/web` | React dashboard: Tailwind CSS + shadcn/ui components (`src/components/ui`), lucide icons |
| `native/macos` | Swift menu-bar agent, on-device transcriber, AgentCore logic + checks |
| `scripts` | Installer, `meeting-recorder` CLI, app build and signing |
| `spike/` | The original capture proof |
| `docs/` | [Architecture](docs/architecture.md), [protocol](docs/protocol.md) |

## License

MIT
