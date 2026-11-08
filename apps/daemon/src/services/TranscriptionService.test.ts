import { EventEmitter } from "node:events";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { makeContainer, silentLog, writeRecording } from "../../test/helpers/harness.ts";
import { newMeeting } from "../models/meeting.ts";
import { MAX_ATTEMPTS, TranscriptionService } from "./TranscriptionService.ts";

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
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: true, summarize: false, language: "auto" } }); // transcripts only
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
    await vi.waitFor(() => expect(children).toHaveLength(2)); // next job spawns after a file save
    expect(children[1]!.args[0]).toContain(older);
  });

  it("does nothing on battery, when disabled, or while recording", async () => {
    const { tx, children, add, container: c } = await setup();
    await add(1);
    tx.setPower("battery");
    expect(children).toHaveLength(0);
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: false, summarize: true, language: "auto" } });
    tx.setPower("ac");
    expect(children).toHaveLength(0);
    await c.recording.toggle(); // recording starts
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: true, summarize: true, language: "auto" } });
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
    await vi.waitFor(() => expect(tx.unavailable).toMatch(/available/));
    expect(children).toHaveLength(1);
    await expect(tx.enqueue(id)).rejects.toThrow(/available/);
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
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: false, summarize: true, language: "auto" } });
    expect(children[0]!.killed).toBe("SIGTERM");
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: true, summarize: true, language: "auto" } });
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

describe("summaries (after transcripts)", () => {
  it("summarizes a meeting after its transcript is done, with --summarize", async () => {
    const { tx, children, add, container: c } = await setup();
    const id = await add(1);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.exit(0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(children[1]!.args).toEqual(["--summarize", c.repo.dir(id)]);
    expect(c.repo.get(id)?.summary).toBe("running");
    writeFileSync(join(c.repo.dir(id), "summary.json"), "{}");
    children[1]!.emit("exit", 0);
    await vi.waitFor(() => expect(c.repo.get(id)?.summary).toBe("done"));
  });

  it("transcripts come before summaries (a newer untranscribed meeting first)", async () => {
    const { tx, children, add, container: c } = await setup();
    const older = await add(1);
    await c.repo.save({ ...c.repo.get(older)!, transcript: "done" });
    c.bus.publish({ type: "meeting", meeting: c.repo.get(older)! });
    const newer = await add(2);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(children[0]!.args[0]).toContain(newer); // newest first: its transcript
  });

  it("summaries switched off: transcripts still run, summaries don't", async () => {
    const { tx, children, add, container: c } = await setup();
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: true, summarize: false, language: "auto" } });
    const id = await add(1);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.exit(0);
    await vi.waitFor(() => expect(c.repo.get(id)?.transcript).toBe("done"));
    await new Promise((r) => setTimeout(r, 30));
    expect(children).toHaveLength(1);
  });

  it("exit 3 on a summary (no Apple Intelligence) disables only summaries", async () => {
    const { tx, children, add, container: c } = await setup();
    const id = await add(1);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.exit(0);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.stdout.write('{"error":"Summaries need Apple Intelligence turned on"}\n');
    await new Promise((r) => setImmediate(r));
    children[1]!.emit("exit", 3);
    await vi.waitFor(() => expect(tx.unavailableFor("summary")).toMatch(/Apple Intelligence/));
    expect(tx.unavailableFor("transcript")).toBeNull();
    expect(c.repo.get(id)?.summary).toBe("none");
    await expect(tx.enqueue(id, "summary")).rejects.toThrow(/Apple Intelligence/);
  });

  it("a summary needs the transcript first", async () => {
    const { tx, add } = await setup();
    const id = await add(1);
    await expect(tx.enqueue(id, "summary")).rejects.toThrow(/transcript first/);
  });

  it("boot requeues a summary interrupted by a crash", async () => {
    const { add, container: c } = await setup();
    const id = await add(1);
    await c.repo.save({ ...c.repo.get(id)!, transcript: "done", summary: "running" });
    const { createContainer } = await import("../container.ts");
    const fresh = await createContainer({
      meetingsDir: c.repo.root, stateDir: c.repo.root, agent: { send() {} }, log: { info() {}, warn() {} },
      dashboardUrl: () => "", openFolder: () => {}, transcriberPath: "/x",
    });
    expect(fresh.repo.get(id)?.summary).toBe("queued");
  });
});

describe("review fixes: manual jobs, retry semantics, stale summaries, language", () => {
  async function transcribed() {
    const ctx = await setup();
    const id = await ctx.add(1);
    await ctx.container.repo.save({ ...ctx.container.repo.get(id)!, transcript: "done" });
    ctx.container.bus.publish({ type: "meeting", meeting: ctx.container.repo.get(id)! });
    return { ...ctx, id };
  }

  it("'Summarize now' runs even when automatic summaries are off", async () => {
    const { tx, children, id, container: c } = await transcribed();
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: true, summarize: false, language: "auto" } });
    tx.setPower("ac");
    await new Promise((r) => setTimeout(r, 20));
    expect(children).toHaveLength(0);
    await tx.enqueue(id, "summary");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(children[0]!.args[0]).toBe("--summarize");
  });

  it("exit 5 (model not ready): queued again without counting a failure; retried later", async () => {
    let t = 1_000_000;
    const { tx, children, id, container: c } = await transcribed();
    (tx as unknown as { now: () => number }).now = () => t;
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.stdout.write('{"error":"still getting ready"}\n');
    await new Promise((r) => setImmediate(r));
    children[0]!.emit("exit", 5);
    await vi.waitFor(() => expect(c.repo.get(id)?.summary).toBe("queued"));
    expect(tx.unavailableFor("summary")).toBe("still getting ready");
    t += 11 * 60_000; // the not-ready window passed
    expect(tx.unavailableFor("summary")).toBeNull();
    tx.pump();
    await vi.waitFor(() => expect(children).toHaveLength(2));
  });

  it("exit 6 (model declined): failed right away with the reason saved; no retries", async () => {
    const { tx, children, id, container: c } = await transcribed();
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.stdout.write('{"error":"declined to summarize"}\n');
    await new Promise((r) => setImmediate(r));
    children[0]!.emit("exit", 6);
    await vi.waitFor(() => expect(c.repo.get(id)?.summary).toBe("failed"));
    expect(c.repo.get(id)?.summaryError).toBe("declined to summarize");
    await new Promise((r) => setTimeout(r, 20));
    expect(children).toHaveLength(1);
  });

  it("exit 3 blocks only until settings change (e.g. Apple Intelligence just turned on)", async () => {
    const { tx, children, container: c } = await transcribed();
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit("exit", 3);
    await vi.waitFor(() => expect(tx.unavailableFor("summary")).not.toBeNull());
    await c.settings.update({ ...c.settings.get() });
    expect(tx.unavailableFor("summary")).toBeNull();
    await vi.waitFor(() => expect(children).toHaveLength(2));
  });

  it("redoing a transcript keeps the old one until replaced, then re-queues the meeting's summary (even with summaries off)", async () => {
    const { tx, children, id, container: c } = await setup().then(async (ctx) => ({ ...ctx, id: await ctx.add(1) }));
    await c.settings.update({ ...c.settings.get(), transcription: { ...c.settings.get().transcription, summarize: false } });
    await c.repo.save({ ...c.repo.get(id)!, transcript: "done", summary: "done" });
    const old = join(c.repo.dir(id), "transcript.json");
    writeFileSync(old, "{}");
    await tx.enqueue(id, "transcript");
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(existsSync(old)).toBe(true); // the good transcript survives while the redo runs
    children[0]!.exit(0);
    await vi.waitFor(() => expect(c.repo.get(id)?.transcript).toBe("done"));
    await vi.waitFor(() => expect(children).toHaveLength(2)); // its summary is rewritten from the new transcript
    expect(children[1]!.args[0]).toBe("--summarize");
  });

  it("an exit 0 that wrote nothing new doesn't count: the old file is from before the run", async () => {
    const { tx, children, id, container: c } = await setup().then(async (ctx) => ({ ...ctx, id: await ctx.add(1) }));
    await c.repo.save({ ...c.repo.get(id)!, transcript: "done" });
    const old = join(c.repo.dir(id), "transcript.json");
    writeFileSync(old, "{}");
    utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await tx.enqueue(id, "transcript");
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.exit(0, false);
    await vi.waitFor(() => expect(children).toHaveLength(2)); // treated as a failure and retried, not "done"
    expect(c.repo.get(id)?.transcript).not.toBe("done");
    expect(existsSync(old)).toBe(true);
  });

  it("a job the user queued still runs after a restart with its automatic setting off", async () => {
    const { container: c, children, add } = await setup();
    const id = await add(1);
    await c.settings.update({ ...c.settings.get(), transcription: { ...c.settings.get().transcription, summarize: false } });
    await c.repo.save({ ...c.repo.get(id)!, transcript: "done", summary: "queued" });
    c.transcription.dispose(); // "restart": a new service with only what's on disk
    const fresh = new TranscriptionService({
      repo: c.repo, bus: c.bus, recording: c.recording, log: silentLog, settings: () => c.settings.get(),
      transcriberPath: "/app/MeetingRecorderTranscriber",
      spawner: (_cmd, args) => { const ch = new FakeChild(args); children.push(ch); return ch as unknown as ChildProcess; },
    });
    await fresh.init();
    fresh.setPower("ac");
    await vi.waitFor(() => expect(children.some((ch) => ch.args[0] === "--summarize")).toBe(true));
    fresh.dispose();
  });

  it("passes the chosen language to the transcriber", async () => {
    const { tx, children, add, container: c } = await setup();
    await c.settings.update({ ...c.settings.get(), transcription: { enabled: true, summarize: false, language: "hi_IN" } });
    await add(1);
    tx.setPower("ac");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(children[0]!.args.slice(-2)).toEqual(["--locale", "hi_IN"]);
  });
});
