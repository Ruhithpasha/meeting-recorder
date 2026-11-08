import { EventEmitter } from "node:events";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { ServerEvent } from "@meeting-recorder/shared";
import { describe, expect, it, vi } from "vitest";
import { makeContainer } from "../../test/helpers/harness.ts";
import { parseCapabilities } from "../container.ts";
import { newMeeting } from "../models/meeting.ts";
import { DEFAULT_SETTINGS } from "@meeting-recorder/shared";
import { jobArgs } from "./TranscriptionService.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  killed: string | null = null;
  readonly args: string[];
  constructor(args: string[]) { super(); this.args = args; }
  kill(signal: string) { this.killed = signal; setImmediate(() => this.emit("exit", null)); return true; }
}

async function setup(transcriber: string | null = "/app/MeetingRecorderTranscriber") {
  const children: FakeChild[] = [];
  const ctx = await makeContainer({
    transcriberPath: transcriber,
    spawner: (_cmd, args) => { const c = new FakeChild(args); children.push(c); return c as unknown as ChildProcess; },
  });
  const events: ServerEvent[] = [];
  ctx.container.bus.subscribe((e) => events.push(e));
  const save = async (patch: object = {}) => {
    const m = { ...newMeeting("2026-11-08_10-00-00_zoom", "Zoom", "Standup", new Date()), status: "complete" as const, ...patch };
    mkdirSync(ctx.container.repo.dir(m.id), { recursive: true });
    await ctx.container.repo.save(m);
    writeFileSync(join(ctx.container.repo.dir(m.id), "recording.mp4"), "video");
    return m.id;
  };
  return { ...ctx, children, events, save, share: ctx.container.share };
}

describe("ShareService", () => {
  it("shares the original and the summary straight away (fixed file names only)", async () => {
    const { share, save, agent } = await setup();
    const id = await save({ summary: "done" });
    expect(await share.share(id, "original")).toEqual({ state: "shared" });
    expect(agent.last("share")).toEqual({ cmd: "share", meetingId: id, file: "recording.mp4" });
    await share.share(id, "summary");
    expect(agent.last("share")?.file).toBe("summary.md");
  });

  it("makes the smaller copy once, reports progress, then opens the share sheet", async () => {
    const { share, save, agent, children, events, container } = await setup();
    const id = await save();
    expect(await share.share(id, "video")).toEqual({ state: "exporting" });
    expect(await share.share(id, "video")).toEqual({ state: "exporting" }); // second click: same job
    expect(children).toHaveLength(1);
    expect(children[0]!.args[0]).toBe("--export");
    children[0]!.stdout.write('{"percent":40}\n');
    await vi.waitFor(() => expect(events).toContainEqual({ type: "share", id, state: "exporting", percent: 40 }));
    writeFileSync(join(container.repo.dir(id), "share.mp4"), "copy");
    children[0]!.emit("exit", 0);
    await vi.waitFor(() => expect(agent.last("share")?.file).toBe("share.mp4"));
    expect(events.at(-1)).toEqual({ type: "share", id, state: "ready" });
    // Fresh copy: shared at once, no second export.
    expect(await share.share(id, "video")).toEqual({ state: "shared" });
    expect(children).toHaveLength(1);
  });

  it("remakes a copy that is older than its recording", async () => {
    const { share, save, children, container } = await setup();
    const id = await save();
    const copy = join(container.repo.dir(id), "share.mp4");
    writeFileSync(copy, "old copy");
    utimesSync(copy, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(await share.share(id, "video")).toEqual({ state: "exporting" });
    expect(children).toHaveLength(1);
  });

  it("reports a failed copy and refuses a second meeting while one is being made", async () => {
    const { share, save, children, events } = await setup();
    const a = await save();
    const b = await save({ id: "2026-11-08_11-00-00_zoom" });
    await share.share(a, "video");
    await expect(share.share(b, "video")).rejects.toThrow(/another meeting/);
    children[0]!.stdout.write('{"error":"Writing the copy failed."}\n');
    await new Promise((r) => setImmediate(r));
    children[0]!.emit("exit", 4);
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "share", id: a, state: "failed", error: "Writing the copy failed." }));
  });

  it("stops making a copy when its meeting is deleted", async () => {
    const { share, save, children, container } = await setup();
    const id = await save();
    await share.share(id, "video");
    container.bus.publish({ type: "meetingDeleted", id });
    expect(children[0]!.killed).toBe("SIGTERM");
  });

  it("a recording starting stops the copy, and no copy starts while recording", async () => {
    const { share, save, children, events, container } = await setup();
    const id = await save();
    await share.share(id, "video");
    container.bus.publish({ type: "status", status: { ...container.status.get(), state: "recording" } });
    expect(children[0]!.killed).toBe("SIGTERM");
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ type: "share", id, state: "failed", error: expect.stringMatching(/recording started/) }));
    await container.recording.toggle(); // now recording
    const other = await save({ id: "2026-11-08_14-00-00_zoom" });
    await expect(share.share(other, "video")).rejects.toThrow(/after the recording ends/);
    expect(await share.share(other, "original")).toEqual({ state: "shared" }); // the original is fine
  });

  it("reports a spawn error once (error then exit)", async () => {
    const { share, save, children, events } = await setup();
    const id = await save();
    await share.share(id, "video");
    children[0]!.emit("error", new Error("spawn failed"));
    children[0]!.emit("exit", 1);
    await new Promise((r) => setImmediate(r));
    expect(events.filter((e) => e.type === "share" && e.state === "failed")).toHaveLength(1);
  });

  it("rejects what can't be shared", async () => {
    const { share, save } = await setup(null);
    const live = await save({ status: "recording" });
    await expect(share.share(live, "original")).rejects.toThrow(/Only saved recordings/);
    const id = await save({ id: "2026-11-08_12-00-00_zoom" });
    await expect(share.share(id, "summary")).rejects.toThrow(/no summary/);
    await expect(share.share(id, "video")).rejects.toThrow(/isn't installed/);
    await expect(share.share("2026-11-08_13-00-00_none", "original")).rejects.toThrow(/not found/i);
  });
});

describe("open-model engines", () => {
  const t = DEFAULT_SETTINGS.transcription;
  it("passes the engine and models folder only for open models", () => {
    expect(jobArgs("transcript", "/m/r.mp4", "/m", t, "/models")).toEqual(["/m/r.mp4", "/m"]);
    expect(jobArgs("transcript", "/m/r.mp4", "/m", { ...t, engine: "whisper", language: "hi_IN" }, "/models"))
      .toEqual(["/m/r.mp4", "/m", "--locale", "hi_IN", "--engine", "whisper", "--models", "/models"]);
    expect(jobArgs("summary", "/m/r.mp4", "/m", { ...t, summaryEngine: "qwen" }, "/models")).toEqual(["--summarize", "/m", "--engine", "qwen", "--models", "/models"]);
  });

  it("parses --capabilities defensively", () => {
    expect(parseCapabilities('{"locales":["en_IN","bad id"],"whisperLanguages":["hi","x y"],"whisper":null,"qwen":"Needs 8 GB"}'))
      .toEqual({ locales: ["en_IN"], whisperLanguages: ["hi"], whisper: null, qwen: "Needs 8 GB" });
    expect(parseCapabilities("not json")).toBeNull();
    expect(parseCapabilities('{"whisper":null}')).toBeNull();
  });
});
