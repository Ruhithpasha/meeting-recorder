import type { MicEvent } from "@meeting-recorder/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeContainer } from "../../test/helpers/harness.ts";
import { compileRules, matchMeeting, OWN_BUNDLE_ID, START_AFTER_MS, STOP_AFTER_MS, type DetectionRule, CONTINUE_AFTER_MS, MAX_CONTINUATIONS } from "./DetectionService.ts";
import rulesFile from "./detection-rules.json" with { type: "json" };

const rules = compileRules(rulesFile.rules as DetectionRule[]);
const mic = (users: string[], windows: [string, string][] = []): MicEvent => ({
  type: "mic",
  users: users.map((bundleId, pid) => ({ bundleId, pid })),
  windows: windows.map(([bundleId, title]) => ({ bundleId, title })),
});
const off = mic([]);

describe("matchMeeting (rules)", () => {
  it.each([
    ["us.zoom.xos", "Zoom"],
    ["com.microsoft.teams2", "Microsoft Teams"],
    ["Cisco-Systems.Spark", "Webex"],
    ["com.tinyspeck.slackmacgap", "Slack huddle"],
    ["com.apple.FaceTime", "FaceTime"],
  ])("native app %s on mic alone -> %s", (bundleId, label) => {
    expect(matchMeeting(mic([bundleId]), rules, [])).toEqual({ app: label, title: label });
  });

  it.each([
    ["com.google.Chrome.helper", "com.google.Chrome", "Meet - abc-defg-hij", "Google Meet"],
    ["com.apple.WebKit.GPU", "com.apple.Safari", "Microsoft Teams (work)", "Microsoft Teams"],
    ["com.microsoft.edgemac.helper", "com.microsoft.edgemac", "Zoom Meeting", "Zoom"],
    ["org.mozilla.firefox", "org.mozilla.firefox", "Webex Meetings", "Webex"],
  ])("browser helper %s + window '%s' -> meeting", (helper, windowApp, title, label) => {
    expect(matchMeeting(mic([helper], [[windowApp, title]]), rules, [])).toEqual({ app: label, title });
  });

  it("browser using the mic without a meeting window does NOT match (Discord web, dictation, ChatGPT voice)", () => {
    expect(matchMeeting(mic(["com.google.Chrome.helper"], [["com.google.Chrome", "ChatGPT"]]), rules, [])).toBeNull();
    expect(matchMeeting(mic(["com.google.Chrome.helper"], []), rules, [])).toBeNull();
  });

  it("a meeting title in a different app's window doesn't count for the browser", () => {
    expect(matchMeeting(mic(["com.google.Chrome.helper"], [["com.apple.Notes", "Meet - notes"]]), rules, [])).toBeNull();
  });

  it("unknown apps and our own agent never match", () => {
    expect(matchMeeting(mic(["com.apple.VoiceMemos"]), rules, [])).toBeNull();
    expect(matchMeeting(mic([OWN_BUNDLE_ID]), rules, [])).toBeNull();
    expect(matchMeeting(mic(["com.hnc.Discord"]), rules, [])).toBeNull();
  });

  it("extra apps from settings match on mic alone", () => {
    expect(matchMeeting(mic(["com.hnc.Discord"]), rules, ["com.hnc.Discord"])).toEqual({ app: "com.hnc.Discord", title: "com.hnc.Discord" });
  });
});

describe("DetectionService hysteresis", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());
  const zoom = mic(["us.zoom.xos"]);

  it(`starts only after the match holds ${START_AFTER_MS} ms`, async () => {
    const { container: c, agent } = await makeContainer();
    c.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS - 1);
    await c.recording.settled();
    expect(agent.starts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await c.recording.settled();
    expect(agent.starts).toHaveLength(1);
    expect(c.recording.isAutoStarted).toBe(true);
  });

  it("a match that drops before the start delay never starts", async () => {
    const { container: c, agent } = await makeContainer();
    c.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS - 500);
    c.detection.onMic(off);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS * 2);
    expect(agent.starts).toHaveLength(0);
  });

  async function autoRecording() {
    const ctx = await makeContainer();
    ctx.container.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS);
    await ctx.container.recording.settled();
    await ctx.container.recording.dispatch({ type: "agentStarted", meetingId: ctx.agent.starts[0]!.meetingId });
    return ctx;
  }

  it(`stops an auto recording only after the match is gone ${STOP_AFTER_MS} ms`, async () => {
    const { container: c, agent } = await autoRecording();
    c.detection.onMic(off);
    await vi.advanceTimersByTimeAsync(STOP_AFTER_MS - 1);
    await c.recording.settled();
    expect(agent.last("stop")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await c.recording.settled();
    expect(agent.last("stop")).toBeDefined();
  });

  it("the recorder failing mid-meeting continues in a new recording (not suppressed like a user stop)", async () => {
    const { container: c, agent } = await autoRecording();
    const first = agent.starts[0]!.meetingId;
    await c.recording.dispatch({ type: "agentError", meetingId: first, code: "writer", message: "-16341" });
    expect(c.recording.stateName).toBe("idle");
    await vi.advanceTimersByTimeAsync(CONTINUE_AFTER_MS);
    await c.recording.settled();
    expect(agent.starts).toHaveLength(2);
    expect(c.repo.get(agent.starts[1]!.meetingId)?.title).toMatch(/ \(continued\)$/);
    expect(c.recording.isAutoStarted).toBe(true);
  });

  it(`continues at most ${MAX_CONTINUATIONS} times per meeting, without stacking "(continued)"`, async () => {
    const { container: c, agent } = await autoRecording();
    const titles: string[] = [];
    for (let i = 0; i < MAX_CONTINUATIONS + 1; i++) {
      const id = agent.starts.at(-1)!.meetingId;
      titles.push(c.repo.get(id)!.title);
      await c.recording.dispatch({ type: "agentStarted", meetingId: id });
      await c.recording.dispatch({ type: "agentError", meetingId: id, code: "writer", message: "x" });
      await vi.advanceTimersByTimeAsync(CONTINUE_AFTER_MS);
      await c.recording.settled();
    }
    expect(agent.starts).toHaveLength(1 + MAX_CONTINUATIONS);
    expect(titles.at(-1)!.match(/continued/g)).toHaveLength(1);
  });

  it("a recording the user stopped is not restarted (only failures continue)", async () => {
    const { container: c, agent } = await autoRecording();
    await c.recording.toggle(); // user stops
    await c.recording.dispatch({ type: "agentStopped", meetingId: agent.starts[0]!.meetingId, durationSec: 5 });
    await vi.advanceTimersByTimeAsync(START_AFTER_MS * 3);
    c.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS * 3);
    expect(agent.starts).toHaveLength(1);
  });

  it("a brief mute (match returns) cancels the stop", async () => {
    const { container: c, agent } = await autoRecording();
    c.detection.onMic(off);
    await vi.advanceTimersByTimeAsync(STOP_AFTER_MS - 1000);
    c.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(STOP_AFTER_MS * 2);
    expect(agent.last("stop")).toBeUndefined();
    expect(c.recording.stateName).toBe("recording");
  });

  it("after the user stops an auto recording mid-meeting, it does NOT restart until the meeting ends", async () => {
    const { container: c, agent } = await autoRecording();
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await c.recording.dispatch({ type: "agentStopped", meetingId: agent.starts[0]!.meetingId, durationSec: 60 });
    c.detection.onMic(mic(["us.zoom.xos"], [["us.zoom.xos", "Zoom Meeting"]])); // title change etc.
    await vi.advanceTimersByTimeAsync(START_AFTER_MS * 3);
    await c.recording.settled();
    expect(agent.starts).toHaveLength(1);

    c.detection.onMic(off); // meeting over
    c.detection.onMic(zoom); // next meeting
    await vi.advanceTimersByTimeAsync(START_AFTER_MS);
    await c.recording.settled();
    expect(agent.starts).toHaveLength(2);
  });

  it("a failed auto start is not retried every 3 s while the meeting continues", async () => {
    const { container: c, agent } = await makeContainer();
    c.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS);
    await c.recording.settled();
    await c.recording.dispatch({ type: "agentError", meetingId: agent.starts[0]!.meetingId, code: "permission", message: "denied" });
    c.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS * 5);
    await c.recording.settled();
    expect(agent.starts).toHaveLength(1);
  });

  it("a pending stop doesn't end a manual recording started before it fires", async () => {
    const { container: c, agent } = await autoRecording();
    c.detection.onMic(off); // auto meeting ended: stop timer armed
    await c.recording.dispatch({ type: "stop", reason: "manual" });
    await c.recording.dispatch({ type: "agentStopped", meetingId: agent.starts[0]!.meetingId, durationSec: 1 });
    await c.recording.toggle(); // user starts a manual recording
    await c.recording.dispatch({ type: "agentStarted", meetingId: agent.starts[1]!.meetingId });
    const stopsBefore = agent.sent.filter((s) => s.cmd === "stop").length;
    await vi.advanceTimersByTimeAsync(STOP_AFTER_MS * 2);
    await c.recording.settled();
    expect(agent.sent.filter((s) => s.cmd === "stop")).toHaveLength(stopsBefore);
    expect(c.recording.stateName).toBe("recording");
  });

  it("never stops a manual recording", async () => {
    const { container: c, agent } = await makeContainer();
    await c.recording.toggle();
    await c.recording.dispatch({ type: "agentStarted", meetingId: agent.starts[0]!.meetingId });
    c.detection.onMic(off);
    await vi.advanceTimersByTimeAsync(STOP_AFTER_MS * 2);
    expect(agent.last("stop")).toBeUndefined();
  });

  it("does nothing when auto-record is off in settings", async () => {
    const { container: c, agent } = await makeContainer();
    await c.settings.update({ ...c.settings.get(), autoRecord: false });
    c.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS * 2);
    expect(agent.starts).toHaveLength(0);
  });

  it("does nothing when disabled (protocol mismatch), including a start already pending", async () => {
    const { container: c, agent } = await makeContainer();
    c.detection.onMic(zoom);
    c.detection.setEnabled(false);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS * 2);
    c.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS * 2);
    expect(agent.starts).toHaveLength(0);
  });

  it("repeated match events while waiting start only once", async () => {
    const { container: c, agent } = await makeContainer();
    c.detection.onMic(zoom);
    c.detection.onMic(zoom);
    c.detection.onMic(zoom);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS);
    await c.recording.settled();
    expect(agent.starts).toHaveLength(1);
  });
});
