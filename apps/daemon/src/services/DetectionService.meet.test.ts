import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeContainer } from "../../test/helpers/harness.ts";
import { CONTINUE_AFTER_MS, START_AFTER_MS } from "./DetectionService.ts";

describe("Google Meet in Chrome (window title + our own app on the mic)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  it("a writer failure mid-call continues in a new recording", async () => {
    const { container: c, agent } = await makeContainer();
    const meet = { type: "mic" as const, users: [{ bundleId: "com.google.Chrome.helper", pid: 1 }], windows: [{ bundleId: "com.google.Chrome", pid: 1, title: "Meet – zqk-gbtr-bpc" }] };
    await c.onAgentEvent(meet);
    await vi.advanceTimersByTimeAsync(START_AFTER_MS);
    await c.recording.settled();
    const id = agent.starts[0]!.meetingId;
    await c.onAgentEvent({ type: "recording", state: "started", meetingId: id });
    // our own app now also uses the mic: the agent reports both
    await c.onAgentEvent({ ...meet, users: [...meet.users, { bundleId: "com.meetingrecorder.agent", pid: 2 }] });
    await c.onAgentEvent({ type: "recording", state: "error", meetingId: id, error: { code: "writer", message: "-16341" } });
    await vi.advanceTimersByTimeAsync(CONTINUE_AFTER_MS + 10);
    await c.recording.settled();
    expect(agent.starts).toHaveLength(2);
  });
});
