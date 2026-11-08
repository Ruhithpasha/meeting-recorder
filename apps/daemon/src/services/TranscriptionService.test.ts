import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { makeContainer, writeRecording } from "../../test/helpers/harness.ts";
import { newMeeting } from "../models/meeting.ts";
import { MAX_ATTEMPTS } from "./TranscriptionService.ts";

/** A fake transcriber process the test finishes on demand. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  killed: string | null = null;
  readonly args: string[];
  constructor(args: string[]) { super(); this.args = args; }
  kill(signal: string) { this.killed = signal; setImmediate(() => this.emit("exit", null)); return true; }
  exit(code: number, writeTranscript = code === 0) {
    if (writeTranscript) writeFileSync(join(this.args[1]!, "transcript.json"), '{"version":1,"segments":[]}');
    this.emit("exit", code);
  }
}

async function setup(opts: { transcriber?: string | null } = {}) {
  const children: FakeChild[] = [];
  const ctx = await makeContainer({
    transcriberPath: opts.transcriber === undefined ? "/app/MeetingRecorderTranscriber" : opts.transcriber,
    spawner: (_cmd, args) => { const c = new FakeChild(args); children.push(c); return c as unknown as ChildProcess; },
  });
  const tx = ctx.container.transcription;
  const add = async (n: number, extra: { status?: "complete" | "recovered" | "recording" } = {}) => {
    const id = `2026-11-0${n}_10-00-00_zoom`;
    const meeting = { ...newMeeting(id, "Zoom", "x", new Date()), status: extra.status ?? "complete" };
    await ctx.container.repo.create(meeting);
    writeRecording(join(ctx.dirs.meetingsDir, id), Buffer.alloc(10));
    ctx.container.bus.publish({ type: "meeting", meeting }); // what RecordingService does on finish
    return id;
  };
  const settle = () => new Promise((r) => setImmediate(r));
  return { ...ctx, tx, children, add, settle };
}

describe("TranscriptionService", () => {
  it("waits for AC power, then transcribes newest first and marks done", async () => {
    const { tx, children, add, container: c, settle } = await setup();
    const older = await add(1);
    const newer = await add(2);
    tx.pump();
    expect(children).toHaveLength(0); // power unknown: don't run
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(children[0]!.args[0]).toContain(newer);
    expect(c.repo.get(newer)?.transcript).toBe("running");
    children[0]!.exit(0);
    await vi.waitFor(() => expect(c.repo.get(newer)?.transcript).toBe("done"));
    await settle();
    expect(children).toHaveLength(2);
    expect(children[1]!.args[0]).toContain(older);
  });

  it("does nothing on battery, when disabled, or while recording", async () => {
    const { tx, children, add, container: c } = await setup();
    await add(1);
    tx.setPower("battery");
    expect(children).toHaveLength(0);
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: false, model: "base" } });
    tx.setPower("ac");
    expect(children).toHaveLength(0);
    await c.recording.toggle(); // recording starts
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: true, model: "base" } });
    expect(children).toHaveLength(0);
  });

  it("a recording starting cancels the running job and requeues it; idle resumes it", async () => {
    const { tx, children, add, container: c, agent } = await setup();
    const id = await add(1);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await c.recording.toggle(); // starting -> status event cancels the job
    expect(children[0]!.killed).toBe("SIGTERM");
    await vi.waitFor(() => expect(c.repo.get(id)?.transcript).toBe("queued"));
    const live = agent.starts[0]!.meetingId;
    await c.recording.dispatch({ type: "agentError", meetingId: live, code: "capture", message: "x" }); // -> idle
    await vi.waitFor(() => expect(children).toHaveLength(2));
  });

  it("unplugging cancels the running job", async () => {
    const { tx, children, add } = await setup();
    await add(1);
    tx.setPower("ac");
    tx.setPower("battery"); // cancelled while the job is still getting ready
    await vi.waitFor(() => expect(children[0]?.killed).toBe("SIGTERM"));
  });

  it(`retries a failing meeting, then marks it failed after ${MAX_ATTEMPTS} attempts; manual retry resets`, async () => {
    const { tx, children, add, container: c } = await setup();
    const id = await add(1);
    tx.setPower("ac");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await vi.waitFor(() => expect(children).toHaveLength(i + 1));
      children[i]!.exit(4);
    }
    await vi.waitFor(() => expect(c.repo.get(id)?.transcript).toBe("failed"));
    expect(children).toHaveLength(MAX_ATTEMPTS);
    await tx.enqueue(id);
    await vi.waitFor(() => expect(children).toHaveLength(MAX_ATTEMPTS + 1));
  });

  it("exit 0 without a transcript file counts as a failure", async () => {
    const { tx, children, add, container: c } = await setup();
    const id = await add(1);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.exit(0, false);
    await vi.waitFor(() => expect(children).toHaveLength(2)); // counted as a failure and retried
    expect(c.repo.get(id)?.transcript).toBe("running");
  });

  it("exit 3 (macOS < 26 / language) disables transcription instead of retrying forever", async () => {
    const { tx, children, add, container: c } = await setup();
    const id = await add(1);
    await add(2);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.exit(3);
    await vi.waitFor(() => expect(tx.unavailable).toMatch(/isn't available/));
    expect(children).toHaveLength(1);
    await expect(tx.enqueue(id)).rejects.toThrow(/isn't available/);
    expect(c.repo.get(id)?.transcript).toBe("none");
  });

  it("without the transcriber binary, transcription is unavailable", async () => {
    const { tx, children, add } = await setup({ transcriber: null });
    await add(1);
    tx.setPower("ac");
    expect(children).toHaveLength(0);
    expect(tx.unavailable).toMatch(/isn't installed/);
  });

  it("two triggers in a row start only one job (slot reserved before any await)", async () => {
    const { tx, children, add } = await setup();
    await add(1);
    await add(2);
    tx.setPower("ac");
    tx.pump();
    tx.pump();
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(children).toHaveLength(1);
  });

  it("skips meetings still recording, and done/failed ones", async () => {
    const { tx, children, add, container: c } = await setup();
    await add(1, { status: "recording" });
    const done = await add(2);
    await c.repo.save({ ...c.repo.get(done)!, transcript: "done" });
    tx.setPower("ac");
    expect(children).toHaveLength(0);
  });

  it("enqueue validates the meeting", async () => {
    const { tx, add } = await setup();
    await expect(tx.enqueue("2020-01-01_00-00-00_none")).rejects.toThrow(/not found/);
    const live = await add(1, { status: "recording" });
    await expect(tx.enqueue(live)).rejects.toThrow(/Only saved recordings/);
  });

  it("boot resets a job left 'running' by a crash, and builds the queue from disk", async () => {
    const { add, container: c, children } = await setup();
    const id = await add(1);
    await c.repo.save({ ...c.repo.get(id)!, transcript: "running" }); // crash mid-job
    const { createContainer } = await import("../container.ts");
    const children2: unknown[] = [];
    const fresh = await createContainer({
      meetingsDir: c.repo.root, stateDir: c.repo.root, agent: { send() {} }, log: { info() {}, warn() {} },
      dashboardUrl: () => "", openFolder: () => {}, transcriberPath: "/x",
      spawner: (_cmd, args) => { children2.push(args); return new FakeChild(args) as unknown as ChildProcess; },
    });
    expect(fresh.repo.get(id)?.transcript).toBe("queued");
    fresh.transcription.setPower("ac");
    await vi.waitFor(() => expect(children2).toHaveLength(1));
    void children;
  });

  it("turning transcription off cancels a running job; deleting its meeting does too", async () => {
    const { tx, children, add, container: c } = await setup();
    const id = await add(1);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: false, model: "base" } });
    expect(children[0]!.killed).toBe("SIGTERM");
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: true, model: "base" } });
    await vi.waitFor(() => expect(children).toHaveLength(2));
    c.bus.publish({ type: "meetingDeleted", id });
    expect(children[1]!.killed).toBe("SIGTERM");
  });

  it("only exit 3 with the transcriber's own reason disables transcription", async () => {
    const { tx, children, add } = await setup();
    await add(1);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.stdout.write('{"error":"Transcription doesn\'t support this language yet."}\n');
    await new Promise((r) => setImmediate(r));
    children[0]!.exit(3);
    await vi.waitFor(() => expect(tx.unavailable).toBe("Transcription doesn't support this language yet."));
  });

  it("the watchdog scales with the recording length", async () => {
    const { timeoutMs } = await import("./TranscriptionService.ts");
    expect(timeoutMs(60)).toBe((120 + 600) * 1000);
    expect(timeoutMs(null)).toBe((7200 + 600) * 1000);
  });
});
