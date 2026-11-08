import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeLine, parseAgentEvent, parseDaemonCommand, PROTOCOL_VERSION } from "./protocol.ts";

const fixtures = join(import.meta.dirname, "../fixtures/protocol");
const load = (dir: string) =>
  readdirSync(join(fixtures, dir)).map((name) => ({ name, line: readFileSync(join(fixtures, dir, name), "utf8").trim() }));

// Fixtures named cmd-*.json are daemon -> agent; everything else is agent -> daemon.
const parse = (name: string, line: string) => (name.startsWith("cmd-") ? parseDaemonCommand(line) : parseAgentEvent(line));

describe("protocol fixtures (also decoded by the Swift agent's validator tests)", () => {
  it.each(load("valid"))("accepts and round-trips $name", ({ name, line }) => {
    const result = parse(name, line);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(JSON.parse(encodeLine(result.value))).toEqual(JSON.parse(line));
    expect(encodeLine(result.value).endsWith("\n")).toBe(true);
    expect(encodeLine(result.value).slice(0, -1)).not.toContain("\n");
  });

  it.each(load("invalid"))("rejects $name", ({ name, line }) => {
    expect(parse(name, line)).toMatchObject({ ok: false });
  });
});

describe("parse errors", () => {
  it("rejects non-JSON", () => {
    expect(parseAgentEvent("not json")).toEqual({ ok: false, error: "not valid JSON" });
  });
  it("does not accept a daemon command as an agent event", () => {
    expect(parseAgentEvent('{"cmd":"stop","meetingId":"x"}')).toMatchObject({ ok: false });
  });
  it("reports the error from the intended message type, not the first union branch", () => {
    const result = parseAgentEvent('{"type":"power","state":"exploded"}');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error).toContain("/state");
      expect(result.error).not.toContain("protocolVersion");
    }
  });
});

it("protocol version is a positive integer", () => {
  expect(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0).toBe(true);
});
