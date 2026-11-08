import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentEvent } from "@meeting-recorder/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentChannel } from "./AgentChannel.ts";

const fixtures = join(import.meta.dirname, "../../../../packages/shared/fixtures/protocol/valid");
const tick = () => new Promise((r) => setImmediate(r));

function channel() {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: AgentEvent[] = [];
  const warn = vi.fn();
  const onClose = vi.fn();
  const ch = new AgentChannel({ input, output, log: { info() {}, warn }, onEvent: (e) => events.push(e), onClose });
  const written = () => output.read()?.toString() ?? "";
  return { input, output, ch, events, warn, onClose, written };
}

describe("AgentChannel", () => {
  it("delivers every valid agent fixture", async () => {
    const { input, events } = channel();
    const lines = readdirSync(fixtures).filter((f) => !f.startsWith("cmd-")).map((f) => readFileSync(join(fixtures, f), "utf8").trim());
    input.write(`${lines.join("\n")}\n`);
    await tick();
    expect(events).toHaveLength(lines.length);
  });

  it("handles lines split across chunks and CRLF", async () => {
    const { input, events } = channel();
    input.write('{"type":"tray",');
    input.write('"action":"toggle"}\r\n');
    await tick();
    expect(events).toEqual([{ type: "tray", action: "toggle" }]);
  });

  it("drops invalid lines with a warning and keeps going", async () => {
    const { input, events, warn } = channel();
    input.write('not json\n{"type":"explode"}\n\n{"type":"tray","action":"quit"}\n');
    await tick();
    expect(events).toEqual([{ type: "tray", action: "quit" }]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("drops absurdly long lines", async () => {
    const { input, events, warn } = channel();
    input.write(`{"type":"mic","users":[],"windows":[{"bundleId":"a","title":"${"x".repeat(1_100_000)}"}]}\n`);
    await tick();
    expect(events).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ bytes: expect.any(Number) }), expect.stringContaining("too long"));
  });

  it("writes one validated line per command", () => {
    const { ch, written } = channel();
    ch.send({ cmd: "stop", meetingId: "2026-11-08_14-30-05_zoom" });
    expect(written()).toBe('{"cmd":"stop","meetingId":"2026-11-08_14-30-05_zoom"}\n');
  });

  it("refuses to send a command the schema forbids", () => {
    const { ch, written, warn } = channel();
    ch.send({ cmd: "openUrl", url: "file:///Applications/Calculator.app" });
    expect(written()).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  it("reports close when stdin ends (agent gone), and stops sending", async () => {
    const { input, ch, onClose, written } = channel();
    input.end();
    await tick();
    expect(onClose).toHaveBeenCalledOnce();
    ch.send({ cmd: "state", status: "idle" });
    expect(written()).toBe("");
  });
});
