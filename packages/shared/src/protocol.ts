// Agent <-> daemon wire protocol: NDJSON (one JSON object per line) over the daemon's stdin/stdout.
//
//   Swift agent ──stdin──▶ daemon   AgentEvent   (discriminated by "type")
//   Swift agent ◀─stdout── daemon   DaemonCommand (discriminated by "cmd")
//
// Types are generated from protocol.schema.json (npm run gen:protocol). Every line crossing the
// process boundary is validated against that same schema before it is trusted.
import { Ajv, type ValidateFunction } from "ajv";
import schema from "../protocol.schema.json" with { type: "json" };
import type {
  HelloEvent, MicEvent, RecordingEvent, TrayEvent, PowerEvent, PermissionEvent,
  StartCommand, StopCommand, StateCommand, OpenUrlCommand, ShareCommand,
} from "./protocol.gen.ts";

export type * from "./protocol.gen.ts";
export { PROTOCOL_VERSION } from "./protocol.gen.ts";

export type AgentEvent = HelloEvent | MicEvent | RecordingEvent | TrayEvent | PowerEvent | PermissionEvent;
export type DaemonCommand = StartCommand | StopCommand | StateCommand | OpenUrlCommand | ShareCommand;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

// discriminator: pick the oneOf branch by "type"/"cmd" first, so errors describe the intended
// message (not the first branch) and each line is checked against one branch, not all of them.
const ajv = new Ajv({ allErrors: false, strict: false, discriminator: true });
ajv.addSchema(schema, "protocol");
const validators = {
  agentEvent: ajv.getSchema("protocol#/definitions/AgentEvent") as ValidateFunction<AgentEvent>,
  daemonCommand: ajv.getSchema("protocol#/definitions/DaemonCommand") as ValidateFunction<DaemonCommand>,
};

function parseWith<T>(validate: ValidateFunction<T>, line: string): ParseResult<T> {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
  if (validate(data)) return { ok: true, value: data };
  const first = validate.errors?.[0];
  return { ok: false, error: first ? `${first.instancePath || "/"} ${first.message}` : "schema mismatch" };
}

/** Meeting folder name rule, from the schema so the daemon and the agent's validator agree. */
export const MEETING_ID_PATTERN = new RegExp(schema.definitions.MeetingId.pattern);

export const parseAgentEvent = (line: string): ParseResult<AgentEvent> => parseWith(validators.agentEvent, line);
export const parseDaemonCommand = (line: string): ParseResult<DaemonCommand> => parseWith(validators.daemonCommand, line);

/** Serializes one message as a single NDJSON line. */
export const encodeLine = (message: AgentEvent | DaemonCommand): string => `${JSON.stringify(message)}\n`;
