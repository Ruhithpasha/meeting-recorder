# Meeting Recorder

Free, open-source, **local-only** meeting recorder for macOS. It sits in your menu bar, notices when a Zoom, Teams, Google Meet, Webex, Slack huddle or FaceTime call starts, and records your screen plus **both sides of the audio** (your mic and everyone else) to `~/Meetings`. It can also transcribe each meeting on your Mac, labelling who spoke ("You" / "Others"). Nothing leaves your Mac: no account, no cloud, no telemetry.

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

- **Automatic:** join a call. After about 3 seconds the menu-bar icon turns red and a notification says recording started. About 15 seconds after the call ends, the recording is saved.
- **Manual:** menu bar → Start/Stop Recording, or the dashboard's button.
- **Stopping early:** if you stop an automatic recording during a call, it won't restart until that call ends.
- **Browser calls (Meet, Teams web):** these need the meeting tab to be the visible tab, because the app checks the window title. Joining with your mic muted at the OS level isn't detected; start those manually.
- **Dashboard:** opens in the app's own window (no browser, nothing hosted). Get there by opening Meeting Recorder from Finder, Spotlight or Launchpad, choosing menu bar → Open Dashboard, or running `meeting-recorder open`.
  - Meetings are grouped by day and searchable.
  - Plays recordings with seeking; transcripts are clickable to jump to a moment.
  - Show in Finder, and delete to the Trash.
  - Settings: quality (720p or 1080p, at 30 or 15 fps), auto-record, transcription, extra apps.
  - Closing the window doesn't stop recording. To stop Meeting Recorder completely, use "Quit Meeting Recorder" in the menu bar or the app menu.
- **Files:** one folder per meeting, for example `~/Meetings/2026-11-08_14-30-05_zoom/`:
  - `recording.mp4`: H.264 video plus two AAC tracks (others, you). It plays in QuickTime.
  - `meta.json`: the meeting's details.
  - `transcript.json` and `transcript.vtt`: the transcript, once it exists.

### Transcription

Transcription runs with Apple's on-device speech engine, **only** when you're not recording, your Mac is plugged in, and it's enabled in Settings. The audio never leaves your Mac. The first time, macOS downloads its speech model for your language. "You" and "Others" come from the two separate audio tracks, so labels are exact rather than guessed.

## Recording consent

Laws in many places require **everyone on a call to agree** before it is recorded. Meeting Recorder shows a red menu-bar icon and a notification whenever it records, and it records your **whole display** by default, so anything visible on screen is saved. You are responsible for getting consent and for what you keep.

## Privacy and resources

- **Local only:**
  - The daemon listens only on `127.0.0.1`.
  - The recorder contains no networking code.
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
| `apps/web` | React dashboard |
| `native/macos` | Swift menu-bar agent, on-device transcriber, AgentCore logic + checks |
| `scripts` | Installer, `meeting-recorder` CLI, app build and signing |
| `spike/` | The original capture proof |
| `docs/` | [Architecture](docs/architecture.md), [protocol](docs/protocol.md) |

## License

MIT
