# Agent ↔ daemon protocol

The Swift agent spawns the Node daemon and they talk over the daemon's **stdin/stdout**, one JSON object per line (NDJSON). The daemon logs to a file, never to stdout, because stdout is the protocol channel.

```
agent ──stdin──▶ daemon    AgentEvent     discriminated by "type"
agent ◀─stdout── daemon    DaemonCommand  discriminated by "cmd"
```

## Single source of truth

[`packages/shared/protocol.schema.json`](../packages/shared/protocol.schema.json) defines every message and the protocol version (`x-protocolVersion`).

- `npm run gen:protocol` generates `packages/shared/src/protocol.gen.ts` and `native/macos/Sources/AgentCore/Protocol.gen.swift` (quicktype), including the `PROTOCOL_VERSION` constant.
- `npm test` runs `check:protocol` first and fails if the generated files are stale.
- The daemon validates every incoming line against the schema (Ajv, discriminated on `type`/`cmd`). Codable can't express patterns or `additionalProperties: false`, so the Swift agent runs its own validator over the same rules.
- Fixtures in `packages/shared/fixtures/protocol/{valid,invalid}` are run by both the TypeScript and Swift test suites.

## Messages

| Direction | Message | Purpose |
|---|---|---|
| agent → daemon | `hello` | First line. Carries `protocolVersion`, `agentVersion`, and `activeMeetingId` if the agent is mid-recording (daemon restarted). |
| agent → daemon | `mic` | Other apps currently using a mic, plus their window titles (for browser meeting detection). Sent on every change. |
| agent → daemon | `recording` | `started` / `stopped` (with `durationSec`) / `error` (with `error.code`: permission, capture, writer, unknown). |
| agent → daemon | `tray` | Menu actions: toggle, openDashboard, openFolder, quit. |
| agent → daemon | `power` | suspend, resume, ac, battery. |
| agent → daemon | `permission` | Screen Recording permission state from the hourly / on-wake preflight. |
| daemon → agent | `start` | Begin capture to `path` (absolute, `…/recording.mp4`) at `height`/`fps`. |
| daemon → agent | `stop` | Finish the recording. |
| daemon → agent | `state` | Menu-bar state and label. |
| daemon → agent | `openUrl` | Open the local dashboard (only `http://127.0.0.1:<port>/` URLs are valid). |

## Versioning

Bump `x-protocolVersion` for any breaking change (removed/renamed field, new required field, narrowed enum), then `npm run gen:protocol`. If the agent's `hello.protocolVersion` differs from the daemon's, the daemon refuses to auto-record and the menu bar says "Run meeting-recorder update".
