# Architecture

```
login (LaunchAgent, KeepAlive)
  └── Meeting Recorder.app (Swift, menu bar)       capture (ScreenCaptureKit), mic detection, permissions
        └── node daemon (apps/daemon, Fastify)     state machine, detection rules, storage, recovery, API
              └── dashboard (apps/web, React)       served on 127.0.0.1, opened in your browser on demand
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

AVAssetWriter writes each fragment's data first, then the `moof` describing it, keeping in-progress data in a size-0 `mdat`. Recovery walks only box headers and `moof`s (never the video data), truncates after the last complete fragment, and sums durations (fragments carry no `tfdt`). It runs **after** the agent's `hello` and skips the meeting the agent reports as still recording, so a daemon restart never touches a live file. Verified against real recordings killed with `kill -9`.

## Meeting detection (`services/DetectionService.ts`, `detection-rules.json`)

- Native apps (Zoom, Teams, Webex, Slack, FaceTime): the app using the mic is enough.
- Browsers: their mic helper process **and** a window whose title matches a meeting pattern (e.g. `Meet - `), so dictation or voice chat in a browser doesn't start a recording.
- Hysteresis: start after the match holds 3 s; stop an auto-started recording after it's gone 15 s. Manual recordings are never auto-stopped.
- Disabled when the agent's protocol version differs.

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
