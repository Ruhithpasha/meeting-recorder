# Meeting Recorder

Free, open-source, **local-only** meeting recorder for macOS. It runs in your menu bar, notices when a Zoom / Teams / Google Meet / Webex call starts, and records your screen plus **both sides of the audio** (your mic and the other participants) to `~/Meetings`. Nothing leaves your Mac: no account, no cloud, no telemetry.

> **Status: in development (v1).** Not installable yet. The capture spike is proven (see [`spike/README.md`](spike/README.md)); the app is being built on the `feat/v1` branch.

## How it works

```
login ─▶ Meeting Recorder.app (Swift, menu bar)          ← capture, mic detection, permissions
           └─ spawns ─▶ node daemon (Fastify, 127.0.0.1)   ← state machine, detection rules, storage, API
                           └─ serves ─▶ dashboard (React)   ← opened in your browser on demand
```

- Recordings: `~/Meetings/<date>_<time>_<app>/recording.mp4` + `meta.json` (no database).
- Memory target: under 80 MB idle, under 250 MB while recording.
- Requires macOS 15 or later.

## Recording consent

Laws in many places require **everyone on a call to agree** before it is recorded. The app shows a red menu-bar icon and a notification whenever it records, and it records your **whole display** by default (anything visible on screen is saved). You are responsible for getting consent.

## Development

Requires Node 22.18+ (TypeScript runs directly via Node's type stripping, no build step) and the Xcode Command Line Tools.

```bash
npm ci
npm test               # checks generated protocol types are fresh, then runs all workspace tests
npm run typecheck
npm run gen:protocol   # after editing packages/shared/protocol.schema.json
```

| Path | What |
|---|---|
| `packages/shared` | Protocol schema (single source of truth), generated types, API types |
| `apps/daemon` | Fastify daemon: routes → controllers → services → repositories → models |
| `apps/web` | React dashboard |
| `native/macos` | Swift agent (menu bar, ScreenCaptureKit capture) |
| `spike/` | Throwaway capture proof |
| `docs/` | Architecture and protocol docs |

## License

MIT
