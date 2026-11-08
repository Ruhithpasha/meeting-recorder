// Table test for the recording state machine (see the diagram in RecordingService.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appleFragmented } from "../../test/helpers/mp4Builder.ts";
import { makeContainer, writeRecording } from "../../test/helpers/harness.ts";
import { START_TIMEOUT_MS, STOP_TIMEOUT_MS } from "./RecordingService.ts";

const auto = { app: "Zoom", title: "Zoom Meeting", source: "auto" as const };
const manual = { app: "Manual", title: "Manual recording", source: "manual" as const };

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
afterEach(() => vi.useRealTimers());

async function started(trigger = auto) {
  const ctx = await makeContainer();
  const { container: c, agent } = ctx;
  await c.recording.dispatch({ type: "start", trigger });
  const id = agent.starts.at(-1)!.meetingId;
  return { ...ctx, c, id };
}

async function recording(trigger = auto) {
  const ctx = await started(trigger);
  await ctx.c.recording.dispatch({ type: "agentStarted", meetingId: ctx.id });
  return ctx;
}

describe("idle", () => {
  it("start: creates the folder + state file, sends start with quality, enters starting", async () => {
    const { c, agent, id, dirs } = await started();
    expect(c.recording.stateName).toBe("starting");
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_zoom$/);
    expect(agent.starts[0]).toMatchObject({ cmd: "start", meetingId: id, height: 720, fps: 30, path: join(dirs.meetingsDir, id, "recording.mp4") });
    expect(existsSync(join(dirs.meetingsDir, id, "recording.state.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dirs.meetingsDir, id, "meta.json"), "utf8"))).toMatchObject({ status: "recording", app: "Zoom" });
    expect(c.status.get()).toMatchObject({ state: "starting", meetingId: id });
  });

  it("start: two starts in the same second get unique folders", async () => {
    const { container: c, agent } = await makeContainer();
    await c.recording.dispatch({ type: "start", trigger: auto });
    await c.recording.dispatch({ type: "agentStarted", meetingId: agent.starts[0]!.meetingId });
    writeRecording(join(c.repo.root, agent.starts[0]!.meetingId), Buffer.alloc(10));
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await c.recording.dispatch({ type: "agentStopped", meetingId: agent.starts[0]!.meetingId, durationSec: 1 });
    await c.recording.dispatch({ type: "start", trigger: auto });
    expect(agent.starts[1]!.meetingId).toBe(`${agent.starts[0]!.meetingId}-1`);
  });

  it("start refused without disk space: stays idle with a warning", async () => {
    const { container: c, agent } = await makeContainer({ freeBytes: 1024 });
    await c.recording.dispatch({ type: "start", trigger: auto });
    expect(c.recording.stateName).toBe("idle");
    expect(agent.starts).toHaveLength(0);
    expect(c.status.get().warning).toMatch(/disk space/);
  });

  it.each(["stop", "agentStarted", "agentStopped", "agentError", "startTimeout", "stopTimeout"] as const)(
    "%s is ignored", async (type) => {
      const { container: c, agent } = await makeContainer();
      const events = {
        stop: { type: "stop", reason: "manual" },
        agentStarted: { type: "agentStarted", meetingId: "x" },
        agentStopped: { type: "agentStopped", meetingId: "x", durationSec: 1 },
        agentError: { type: "agentError", meetingId: "x", code: "unknown", message: "m" },
        startTimeout: { type: "startTimeout", meetingId: "x" },
        stopTimeout: { type: "stopTimeout", meetingId: "x" },
      } as const;
      await c.recording.dispatch(events[type]);
      expect(c.recording.stateName).toBe("idle");
      expect(agent.sent.filter((s) => s.cmd !== "state")).toHaveLength(0);
    });

  it("adopt: takes over a meeting the agent is still recording (daemon restart)", async () => {
    const first = await recording();
    const { createContainer } = await import("../container.ts");
    const fresh = await createContainer({
      meetingsDir: first.dirs.meetingsDir, stateDir: first.dirs.stateDir, agent: first.agent,
      log: { info() {}, warn() {} }, dashboardUrl: () => "", openFolder: () => {},
    });
    await fresh.recording.dispatch({ type: "adopt", meetingId: first.id });
    expect(fresh.recording.stateName).toBe("recording");
    expect(fresh.recording.currentMeetingId).toBe(first.id);
    expect(fresh.recording.isAutoStarted).toBe(true);
  });

  it("adopt of an unknown meeting is ignored", async () => {
    const { container: c } = await makeContainer();
    await c.recording.dispatch({ type: "adopt", meetingId: "2026-01-01_00-00-00_zoom" });
    expect(c.recording.stateName).toBe("idle");
  });
});

describe("starting", () => {
  it("agentStarted -> recording", async () => {
    const { c, id } = await started();
    await c.recording.dispatch({ type: "agentStarted", meetingId: id });
    expect(c.recording.stateName).toBe("recording");
  });

  it("stop while starting is remembered, then applied once recording is confirmed", async () => {
    const { c, id, agent } = await started();
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    expect(c.recording.stateName).toBe("starting");
    await c.recording.dispatch({ type: "agentStarted", meetingId: id });
    expect(c.recording.stateName).toBe("stopping");
    expect(agent.last("stop")).toEqual({ cmd: "stop", meetingId: id });
  });

  it("agentError: deletes the empty folder, warns, back to idle", async () => {
    const { c, id, dirs } = await started();
    await c.recording.dispatch({ type: "agentError", meetingId: id, code: "permission", message: "Screen Recording permission denied" });
    expect(c.recording.stateName).toBe("idle");
    expect(existsSync(join(dirs.meetingsDir, id))).toBe(false);
    expect(c.status.get().warning).toBe("Screen Recording permission denied");
  });

  it(`startTimeout after ${START_TIMEOUT_MS} ms: sends stop, deletes folder, warns`, async () => {
    const { c, id, agent, dirs } = await started();
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
    await c.recording.dispatch({ type: "stop", reason: "manual" }); // flush queue
    expect(c.recording.stateName).toBe("idle");
    expect(agent.last("stop")).toEqual({ cmd: "stop", meetingId: id });
    expect(existsSync(join(dirs.meetingsDir, id))).toBe(false);
    expect(c.status.get().warning).toMatch(/didn't start/);
  });

  it("events for another meeting are ignored", async () => {
    const { c } = await started();
    await c.recording.dispatch({ type: "agentStarted", meetingId: "2020-01-01_00-00-00_other" });
    expect(c.recording.stateName).toBe("starting");
  });

  it("a second start is ignored", async () => {
    const { c, agent } = await started();
    await c.recording.dispatch({ type: "start", trigger: manual });
    expect(agent.starts).toHaveLength(1);
  });
});

describe("recording", () => {
  it("stop -> stopping, sends stop", async () => {
    const { c, id, agent } = await recording();
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    expect(c.recording.stateName).toBe("stopping");
    expect(agent.last("stop")).toEqual({ cmd: "stop", meetingId: id });
  });

  it("agentStopped (agent ended on its own) -> complete meta, state file removed, idle", async () => {
    const { c, id, dirs } = await recording();
    writeRecording(join(dirs.meetingsDir, id), Buffer.alloc(1234));
    await c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 61.5 });
    expect(c.recording.stateName).toBe("idle");
    expect(existsSync(join(dirs.meetingsDir, id, "recording.state.json"))).toBe(false);
    expect(c.repo.get(id)).toMatchObject({ status: "complete", durationSec: 61.5, sizeBytes: 1234 });
    expect(c.repo.get(id)?.endedAt).not.toBeNull();
  });

  it("agentError mid-recording -> file recovered, warning, idle", async () => {
    const { c, id, dirs } = await recording();
    const { bytes } = appleFragmented({
      tracks: [{ id: 1, timescale: 600, initialDuration: 3000, defaultSampleDuration: 40 }],
      fragments: [[{ trackId: 1, sampleDurations: Array<number>(75).fill(40) }]],
      inProgressBytes: 100,
    });
    writeRecording(join(dirs.meetingsDir, id), bytes);
    await c.recording.dispatch({ type: "agentError", meetingId: id, code: "writer", message: "Disk write failed" });
    expect(c.recording.stateName).toBe("idle");
    expect(c.repo.get(id)).toMatchObject({ status: "recovered", durationSec: 10 });
    expect(c.status.get().warning).toBe("Disk write failed");
  });

  it("toggle stops", async () => {
    const { c } = await recording();
    await c.recording.toggle();
    expect(c.recording.stateName).toBe("stopping");
  });
});

describe("stopping", () => {
  it("agentStopped -> complete, idle", async () => {
    const { c, id, dirs } = await recording();
    writeRecording(join(dirs.meetingsDir, id), Buffer.alloc(10));
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 5 });
    expect(c.recording.stateName).toBe("idle");
    expect(c.repo.get(id)?.status).toBe("complete");
  });

  it(`stopTimeout after ${STOP_TIMEOUT_MS} ms -> idle WITHOUT touching the (maybe still written) file`, async () => {
    const { c, id, dirs } = await recording();
    writeRecording(join(dirs.meetingsDir, id), Buffer.alloc(64));
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await c.recording.settled();
    expect(c.recording.stateName).toBe("idle");
    expect(c.repo.get(id)?.status).toBe("recording"); // not truncated, not recovered
    expect(existsSync(join(dirs.meetingsDir, id, "recording.state.json"))).toBe(true);
    expect(c.recording.busyMeetingIds.has(id)).toBe(true);
    expect(c.status.get().warning).toMatch(/taking long/);

    // The agent's late confirmation finalizes the detached meeting.
    await c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 42 });
    expect(c.repo.get(id)).toMatchObject({ status: "complete", durationSec: 42 });
    expect(c.recording.busyMeetingIds.has(id)).toBe(false);
  });

  it("a detached meeting's late result is handled even while a NEW recording is running", async () => {
    const { c, id, dirs, agent } = await recording();
    writeRecording(join(dirs.meetingsDir, id), Buffer.alloc(64));
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await c.recording.dispatch({ type: "start", trigger: manual });
    const second = agent.starts.at(-1)!.meetingId;
    await c.recording.dispatch({ type: "agentStarted", meetingId: second });
    await c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 30 });
    expect(c.repo.get(id)).toMatchObject({ status: "complete", durationSec: 30 });
    expect(c.recording.stateName).toBe("recording");
    expect(c.recording.currentMeetingId).toBe(second);
  });

  it("an error before any data deletes the folder AND tells the dashboard", async () => {
    const { c, id } = await recording();
    const events: string[] = [];
    c.bus.subscribe((e) => events.push(e.type === "meetingDeleted" ? `deleted:${e.id}` : e.type));
    await c.recording.dispatch({ type: "agentError", meetingId: id, code: "capture", message: "no frames" });
    expect(events).toContain(`deleted:${id}`);
    expect(c.repo.get(id)).toBeUndefined();
  });

  it("a detached meeting's late error recovers it", async () => {
    const { c, id, dirs } = await recording();
    writeRecording(join(dirs.meetingsDir, id), Buffer.alloc(64));
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await c.recording.dispatch({ type: "agentError", meetingId: id, code: "writer", message: "late failure" });
    expect(c.repo.get(id)?.status).toBe("recovered");
  });

  it("a file I/O failure while finishing still returns to idle, with a warning", async () => {
    const { c, id, dirs } = await recording();
    writeRecording(join(dirs.meetingsDir, id), Buffer.alloc(10));
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    vi.spyOn(c.repo, "save").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    await c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 5 });
    expect(c.recording.stateName).toBe("idle");
    expect(c.status.get().warning).toMatch(/recovered automatically/);
    await c.recording.dispatch({ type: "start", trigger: manual }); // not stuck: can record again
    expect(c.recording.stateName).toBe("starting");
  });

  it("a second stop is ignored", async () => {
    const { c, agent } = await recording();
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    expect(agent.sent.filter((s) => s.cmd === "stop")).toHaveLength(1);
  });

  it("agentStopped clears the stop timer (no late recovery)", async () => {
    const { c, id, dirs } = await recording();
    writeRecording(join(dirs.meetingsDir, id), Buffer.alloc(10));
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 5 });
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS * 2);
    expect(c.repo.get(id)?.status).toBe("complete");
  });
});

describe("empty stop", () => {
  it("a stop with no recording data removes the meeting and tells the dashboard", async () => {
    const { c, id, dirs } = await recording();
    const events: string[] = [];
    c.bus.subscribe((e) => { if (e.type === "meetingDeleted") events.push(e.id); });
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 0 });
    expect(c.recording.stateName).toBe("idle");
    expect(existsSync(join(dirs.meetingsDir, id))).toBe(false);
    expect(events).toEqual([id]);
  });
});

describe("menu bar state", () => {
  it("sends state commands as the machine moves", async () => {
    const { c, id, agent } = await recording();
    expect(agent.last("state")).toEqual({ cmd: "state", status: "recording", label: "Recording Zoom" });
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await c.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 1 });
    expect(agent.last("state")).toEqual({ cmd: "state", status: "idle" });
  });
});
