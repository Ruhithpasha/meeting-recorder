import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@meeting-recorder/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeContainer } from "../../test/helpers/harness.ts";
import { appleFragmented } from "../../test/helpers/mp4Builder.ts";
import { START_AFTER_MS } from "../services/DetectionService.ts";

const hello = (extra: Record<string, unknown> = {}) =>
  ({ type: "hello", protocolVersion: PROTOCOL_VERSION, agentVersion: "0.1.0", platform: "macos", ...extra }) as const;

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
afterEach(() => vi.useRealTimers());

describe("agent events", () => {
  it("hello: marks the agent connected", async () => {
    const { container: c } = await makeContainer();
    await c.onAgentEvent(hello());
    expect(c.status.get()).toMatchObject({ agentConnected: true, warning: null });
  });

  it("hello with another protocol version: warns and disables auto-recording", async () => {
    const { container: c, agent } = await makeContainer();
    await c.onAgentEvent({ ...hello(), protocolVersion: PROTOCOL_VERSION + 1 });
    expect(c.status.get().warning).toMatch(/meeting-recorder update/);
    expect(agent.last("state")).toMatchObject({ status: "warning" });
    await c.onAgentEvent({ type: "mic", users: [{ bundleId: "us.zoom.xos", pid: 1 }], windows: [] });
    await vi.advanceTimersByTimeAsync(START_AFTER_MS * 2);
    await c.recording.settled();
    expect(agent.starts).toHaveLength(0);
  });

  it("hello runs recovery but skips the meeting the agent is still recording (daemon restart)", async () => {
    vi.useRealTimers();
    const { container: c, dirs } = await makeContainer();
    const { bytes } = appleFragmented({ tracks: [{ id: 1, timescale: 600, initialDuration: 600, defaultSampleDuration: 40 }], fragments: [], inProgressBytes: 50 });
    for (const id of ["2026-11-08_09-00-00_crashed", "2026-11-08_10-00-00_live"]) {
      await c.repo.create({ id, app: "Zoom", title: "x", startedAt: new Date().toISOString(), endedAt: null, durationSec: null, sizeBytes: null, status: "recording", transcript: "none", summary: "none" });
      writeFileSync(join(dirs.meetingsDir, id, "recording.mp4"), bytes);
    }
    await c.onAgentEvent(hello({ activeMeetingId: "2026-11-08_10-00-00_live" }));
    expect(c.repo.get("2026-11-08_09-00-00_crashed")?.status).toBe("recovered");
    expect(c.repo.get("2026-11-08_10-00-00_live")?.status).toBe("recording");
    expect(c.recording.stateName).toBe("recording");
    expect(c.recording.currentMeetingId).toBe("2026-11-08_10-00-00_live");
  });

  it("a late or second hello never deletes the meeting the daemon is starting right now", async () => {
    vi.useRealTimers();
    const { container: c, agent, dirs } = await makeContainer();
    await c.recording.toggle(); // starting: folder + state file, no recording.mp4 yet
    const id = agent.starts[0]!.meetingId;
    await c.onAgentEvent(hello());
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dirs.meetingsDir, id))).toBe(true);
    expect(c.recording.stateName).toBe("starting");
  });

  it("recording started/stopped/error map onto the state machine", async () => {
    const { container: c, agent } = await makeContainer();
    await c.recording.toggle();
    const id = agent.starts[0]!.meetingId;
    await c.onAgentEvent({ type: "recording", state: "started", meetingId: id });
    expect(c.recording.stateName).toBe("recording");
    writeFileSync(join(c.repo.root, id, "recording.mp4"), Buffer.alloc(10));
    await c.onAgentEvent({ type: "recording", state: "stopped", meetingId: id, durationSec: 3 });
    expect(c.repo.get(id)).toMatchObject({ status: "complete", durationSec: 3 });

    await c.recording.toggle();
    const id2 = agent.starts[1]!.meetingId;
    await c.onAgentEvent({ type: "recording", state: "error", meetingId: id2, error: { code: "permission", message: "Allow Screen Recording" } });
    expect(c.status.get().warning).toBe("Allow Screen Recording");
  });

  it("tray: toggle starts, openDashboard sends the URL, openFolder opens the folder", async () => {
    const { container: c, agent, opened } = await makeContainer();
    await c.onAgentEvent({ type: "tray", action: "toggle" });
    expect(agent.starts).toHaveLength(1);
    await c.onAgentEvent({ type: "tray", action: "openDashboard" });
    expect(agent.last("openUrl")).toEqual({ cmd: "openUrl", url: "http://127.0.0.1:47321/#t=test" });
    await c.onAgentEvent({ type: "tray", action: "openFolder" });
    expect(opened).toHaveLength(1);
  });

  it("tray quit and power suspend stop an active recording cleanly", async () => {
    for (const event of [{ type: "tray", action: "quit" }, { type: "power", state: "suspend" }] as const) {
      const { container: c, agent } = await makeContainer();
      await c.recording.toggle();
      await c.onAgentEvent({ type: "recording", state: "started", meetingId: agent.starts[0]!.meetingId });
      await c.onAgentEvent(event);
      expect(c.recording.stateName).toBe("stopping");
    }
  });

  it("tray quit while idle does nothing", async () => {
    const { container: c, agent } = await makeContainer();
    await c.onAgentEvent({ type: "tray", action: "quit" });
    expect(agent.sent.filter((s) => s.cmd !== "state")).toHaveLength(0);
  });

  it("permission denied/granted sets and clears the warning", async () => {
    const { container: c } = await makeContainer();
    await c.onAgentEvent({ type: "permission", screen: "denied" });
    expect(c.status.get().warning).toMatch(/Screen Recording permission is off/);
    await c.onAgentEvent({ type: "permission", screen: "granted" });
    expect(c.status.get().warning).toBeNull();
  });

  it("ignores folders it can't recover without crashing hello", async () => {
    vi.useRealTimers();
    const { container: c, dirs } = await makeContainer();
    const id = "2026-11-08_08-00-00_odd";
    mkdirSync(join(dirs.meetingsDir, id, "recording.mp4"), { recursive: true });
    writeFileSync(join(dirs.meetingsDir, id, "recording.state.json"), "{}");
    await expect(c.onAgentEvent(hello())).resolves.toBeUndefined();
  });

  it("live transcript lines of the meeting being recorded go to the dashboard; stray ones don't", async () => {
    const { container: c, agent } = await makeContainer();
    const events: unknown[] = [];
    c.bus.subscribe((e) => events.push(e));
    await c.recording.toggle();
    const id = agent.starts[0]!.meetingId;
    await c.onAgentEvent({ type: "transcript", meetingId: id, speaker: "You", start: 1, end: 2.5, text: "Hello everyone" });
    await c.onAgentEvent({ type: "transcript", meetingId: "2020-01-01_00-00-00_old", speaker: "Others", start: 1, end: 2, text: "stray" });
    expect(events).toContainEqual({ type: "liveTranscript", id, segment: { start: 1, end: 2.5, speaker: "You", text: "Hello everyone" } });
    expect(JSON.stringify(events)).not.toContain("stray");
    expect(c.live.get(id)).toHaveLength(1);
  });
});
