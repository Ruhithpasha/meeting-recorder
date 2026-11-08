import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeContainer, silentLog } from "../../test/helpers/harness.ts";
import { appleFragmented } from "../../test/helpers/mp4Builder.ts";
import { newMeeting } from "../models/meeting.ts";
import { MergeService } from "./MergeService.ts";
import { RecoveryService } from "./RecoveryService.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  readonly args: string[];
  constructor(args: string[]) { super(); this.args = args; }
  kill() { return true; }
}

/** A fragmented part like the agent writes, with an unfinished tail (a writer that failed). */
const part = () => appleFragmented({
  tracks: [{ id: 1, timescale: 600, initialDuration: 3000, defaultSampleDuration: 40 }],
  fragments: [[{ trackId: 1, sampleDurations: Array<number>(75).fill(40) }]],
  inProgressBytes: 100,
});

async function setup(outcome: "merged" | "fails" = "merged", transcriber: string | null = "/app/MeetingRecorderTranscriber") {
  const { container: c, dirs } = await makeContainer();
  const id = "2026-11-09_10-00-00_google-meet";
  const dir = join(dirs.meetingsDir, id);
  await c.repo.create(newMeeting(id, "Google Meet", "Standup", new Date())); // folder + meta + state file, as a recording does
  const calls: string[][] = [];
  let mergedOverride: string[] | null = null;
  const listed = (): string[] => mergedOverride ?? (JSON.parse(readFileSync(join(dir, "parts.json"), "utf8")) as { parts: { file: string }[] }).parts
    .map((p) => p.file).filter((f) => /^(video|system|mic)-\d+\.mp4$/.test(f));
  const merge = new MergeService({
    repo: c.repo, log: silentLog, transcriberPath: transcriber,
    spawner: (_cmd, args) => {
      calls.push(args);
      const child = new FakeChild(args);
      setImmediate(() => {
        if (outcome === "merged") {
          writeFileSync(join(dir, "recording.mp4"), part().bytes); // what the helper writes
          child.stdout.end(JSON.stringify({ done: true, durationSec: 3, merged: listed() }) + "\n");
          child.emit("close", 0);
        } else {
          child.stdout.end('{"error":"Merging the recording failed: [AVFoundationErrorDomain -11800]"}\n');
          child.emit("close", 4);
        }
      });
      return child as unknown as ChildProcess;
    },
  });
  const writeParts = (parts: { stream: string; file: string; start: number }[]) => {
    for (const p of parts) if (/^(video|system|mic)-\d+\.mp4$/.test(p.file)) writeFileSync(join(dir, p.file), part().bytes);
    writeFileSync(join(dir, "parts.json"), JSON.stringify({ version: 1, parts }));
  };
  return { c, id, dir, merge, calls, writeParts, setMerged: (files: string[]) => { mergedOverride = files; } };
}

describe("MergeService", () => {
  it("a recording without parts needs no merge", async () => {
    const { merge, id, calls } = await setup();
    expect(await merge.mergeParts(id)).toEqual({ status: "none" });
    expect(calls).toHaveLength(0);
  });

  it("trims each part's unfinished tail, merges, then removes the parts", async () => {
    const { merge, id, dir, calls, writeParts } = await setup();
    writeParts([{ stream: "video", file: "video-1.mp4", start: 0 }, { stream: "mic", file: "mic-1.mp4", start: 0.02 }, { stream: "mic", file: "mic-2.mp4", start: 9.5 }]);
    const before = statSync(join(dir, "mic-2.mp4")).size;
    let trimmedBeforeMerge = 0;
    const spy = merge as unknown as { run: (args: string[]) => Promise<unknown> };
    const original = spy.run.bind(merge);
    spy.run = async (args) => { trimmedBeforeMerge = statSync(join(dir, "mic-2.mp4")).size; return original(args); };
    expect(await merge.mergeParts(id)).toEqual({ status: "merged", durationSec: 3 });
    expect(trimmedBeforeMerge).toBeLessThan(before); // the unfinished tail is gone before the helper reads it
    expect(calls).toEqual([["--merge", dir]]);
    expect(existsSync(join(dir, "recording.mp4"))).toBe(true);
    for (const f of ["video-1.mp4", "mic-1.mp4", "mic-2.mp4", "parts.json"]) expect(existsSync(join(dir, f))).toBe(false);
  });

  it("a failed merge keeps every part for a later try", async () => {
    const { merge, id, dir, writeParts } = await setup("fails");
    writeParts([{ stream: "video", file: "video-1.mp4", start: 0 }]);
    expect(await merge.mergeParts(id)).toEqual({ status: "failed" });
    expect(await merge.mergeParts(id)).toEqual({ status: "failed" });
    expect(existsSync(join(dir, "video-1.mp4"))).toBe(true);
    expect(existsSync(join(dir, "parts.json"))).toBe(true);
    expect(await merge.mergeParts(id)).toEqual({ status: "gave-up" }); // the 3rd failure: stop blocking the meeting
    expect(existsSync(join(dir, "video-1.mp4"))).toBe(true);
  });

  it("ignores manifest entries that aren't plain part names (never touches other files)", async () => {
    const { merge, id, dir, writeParts } = await setup();
    writeFileSync(join(dir, "meta-keep.txt"), "x");
    writeParts([{ stream: "video", file: "video-1.mp4", start: 0 }, { stream: "mic", file: "../meta-keep.txt", start: 0 }, { stream: "mic", file: "meta-keep.txt", start: 0 }]);
    expect((await merge.mergeParts(id)).status).toBe("merged");
    expect(readFileSync(join(dir, "meta-keep.txt"), "utf8")).toBe("x");
  });

  it("without the helper, parts are kept", async () => {
    const { merge, id, dir, writeParts } = await setup("merged", null);
    writeParts([{ stream: "video", file: "video-1.mp4", start: 0 }]);
    expect(await merge.mergeParts(id)).toEqual({ status: "gave-up" });
    expect(existsSync(join(dir, "video-1.mp4"))).toBe(true);
  });

  it("a part the helper didn't use is kept on disk", async () => {
    const { merge, id, dir, writeParts, setMerged } = await setup();
    writeParts([{ stream: "video", file: "video-1.mp4", start: 0 }, { stream: "mic", file: "mic-1.mp4", start: 0 }]);
    setMerged(["video-1.mp4"]);
    expect((await merge.mergeParts(id)).status).toBe("merged");
    expect(existsSync(join(dir, "video-1.mp4"))).toBe(false);
    expect(existsSync(join(dir, "mic-1.mp4"))).toBe(true);
  });
});

describe("recordings made of parts", () => {
  it("crash recovery merges the parts, then recovers recording.mp4", async () => {
    const { c, id, merge, writeParts } = await setup();
    writeParts([{ stream: "video", file: "video-1.mp4", start: 0 }, { stream: "system", file: "system-1.mp4", start: 0 }]);
    const recovery = new RecoveryService(c.repo, silentLog, merge);
    const recovered = await recovery.recoverOne(id);
    expect(recovered).toMatchObject({ status: "recovered", durationSec: 10 });
  });

  it("parts that can never be merged: the meeting is finalized as recovered, every file kept", async () => {
    const { c, id, dir, writeParts } = await setup("merged", null); // no helper: gives up at once
    writeParts([{ stream: "video", file: "video-1.mp4", start: 0 }]);
    const recovery = new RecoveryService(c.repo, silentLog, new MergeService({ repo: c.repo, log: silentLog, transcriberPath: null }));
    expect(await recovery.recoverOne(id)).toMatchObject({ status: "recovered", durationSec: null });
    expect(existsSync(join(dir, "video-1.mp4"))).toBe(true);
    expect(await c.repo.idsWithState()).not.toContain(id);
  });

  it("if the merge fails, recovery leaves the meeting for the next start", async () => {
    const { c, id, merge, writeParts } = await setup("fails");
    writeParts([{ stream: "video", file: "video-1.mp4", start: 0 }]);
    const recovery = new RecoveryService(c.repo, silentLog, merge);
    expect((await recovery.run()).recovered).toEqual([]);
    expect(await c.repo.idsWithState()).toContain(id); // retried next time
  });
});

describe("stopping a recording made of parts", () => {
  it("merges the parts, then the meeting is complete with recording.mp4", async () => {
    const ctx = await makeContainer({
      transcriberPath: "/app/MeetingRecorderTranscriber",
      spawner: (_cmd, args) => {
        const child = new FakeChild(args);
        setImmediate(() => {
          if (args[0] === "--merge") {
            writeFileSync(join(args[1]!, "recording.mp4"), part().bytes);
            child.stdout.end(JSON.stringify({ done: true, durationSec: 11.96, merged: ["video-1.mp4", "system-1.mp4", "mic-1.mp4"] }) + "\n");
            child.emit("close", 0);
          }
        });
        return child as unknown as ChildProcess;
      },
    });
    const { container: c, agent } = ctx;
    await c.recording.dispatch({ type: "start", trigger: { app: "Manual", title: "Manual recording", source: "manual" } });
    const id = agent.starts[0]!.meetingId;
    await c.recording.dispatch({ type: "agentStarted", meetingId: id });
    const dir = c.repo.dir(id);
    for (const f of ["video-1.mp4", "system-1.mp4", "mic-1.mp4"]) writeFileSync(join(dir, f), part().bytes);
    writeFileSync(join(dir, "parts.json"), JSON.stringify({ version: 1, parts: [
      { stream: "video", file: "video-1.mp4", start: 0 }, { stream: "system", file: "system-1.mp4", start: 0 }, { stream: "mic", file: "mic-1.mp4", start: 0.02 },
    ] }));
    await c.recording.toggle();
    await c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 12 });
    expect(c.repo.get(id)).toMatchObject({ status: "complete", durationSec: 12 }); // the merged file's length (11.96 → 12.0)
    expect(existsSync(join(dir, "recording.mp4"))).toBe(true);
    expect(existsSync(join(dir, "video-1.mp4"))).toBe(false);
    expect(c.status.get().warning).toBeNull();
  });
});

describe("the recorder is free while the last meeting is merged", () => {
  it("goes idle as soon as the agent stops; the meeting stays busy until merged", async () => {
    let finishMerge: () => void = () => {};
    const ctx = await makeContainer({
      transcriberPath: "/app/MeetingRecorderTranscriber",
      spawner: (_cmd, args) => {
        const child = new FakeChild(args);
        finishMerge = () => {
          writeFileSync(join(args[1]!, "recording.mp4"), part().bytes);
          child.stdout.end(JSON.stringify({ done: true, durationSec: 5, merged: ["video-1.mp4"] }) + "\n");
          child.emit("close", 0);
        };
        return child as unknown as ChildProcess;
      },
    });
    const { container: c, agent } = ctx;
    await c.recording.dispatch({ type: "start", trigger: { app: "Manual", title: "Manual recording", source: "manual" } });
    const id = agent.starts[0]!.meetingId;
    await c.recording.dispatch({ type: "agentStarted", meetingId: id });
    writeFileSync(join(c.repo.dir(id), "video-1.mp4"), part().bytes);
    writeFileSync(join(c.repo.dir(id), "parts.json"), JSON.stringify({ version: 1, parts: [{ stream: "video", file: "video-1.mp4", start: 0 }] }));
    await c.recording.toggle();
    const stopped = c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(c.recording.stateName).toBe("idle");              // free for the next meeting already
    expect(c.recording.busyMeetingIds.has(id)).toBe(true);    // but recovery won't touch this one
    finishMerge();
    await stopped;
    expect(c.recording.busyMeetingIds.has(id)).toBe(false);
    expect(c.repo.get(id)?.status).toBe("complete");
  });
});
