// NDJSON channel to the native agent over this process's stdin/stdout (see docs/protocol.md).
// stdout carries ONLY protocol lines; all logging goes to the log file.
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { encodeLine, parseAgentEvent, parseDaemonCommand, type AgentEvent, type DaemonCommand } from "@meeting-recorder/shared";
import type { Logger } from "../repositories/MeetingRepository.ts";

/** What services need from the agent: a way to send commands. Tests swap in a fake. */
export interface AgentPort {
  send(command: DaemonCommand): void;
}

const MAX_LINE_BYTES = 1024 * 1024; // a mic event with many windows is a few KB; 1 MB is abuse

export class AgentChannel implements AgentPort {
  private readonly output: Writable;
  private readonly log: Logger;
  private closed = false;

  constructor(opts: {
    input: Readable;
    output: Writable;
    log: Logger;
    onEvent: (event: AgentEvent) => void;
    onClose: () => void;
  }) {
    this.output = opts.output;
    this.log = opts.log;
    const lines = createInterface({ input: opts.input, crlfDelay: Number.POSITIVE_INFINITY });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      if (line.length > MAX_LINE_BYTES) {
        this.log.warn({ bytes: line.length }, "agent line too long, dropped");
        return;
      }
      const parsed = parseAgentEvent(line);
      if (parsed.ok) opts.onEvent(parsed.value);
      else this.log.warn({ error: parsed.error, line: line.slice(0, 200) }, "invalid agent message, dropped");
    });
    lines.on("close", () => {
      this.closed = true;
      opts.onClose();
    });
  }

  /** Commands are validated too: a daemon bug must never send the agent something the schema forbids. */
  send(command: DaemonCommand): void {
    if (this.closed) return;
    const line = encodeLine(command);
    const check = parseDaemonCommand(line);
    if (!check.ok) {
      this.log.warn({ error: check.error, command }, "refusing to send invalid command");
      return;
    }
    this.output.write(line);
  }
}
