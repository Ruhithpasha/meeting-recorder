import { describe, expect, it } from "vitest";
import { newMeeting } from "../models/meeting.ts";
import { EventBus } from "./EventBus.ts";
import { LiveTranscriptService } from "./LiveTranscriptService.ts";

const line = (n: number) => ({ start: n, end: n + 1, speaker: "You", text: `line ${n}` });

describe("LiveTranscriptService", () => {
  it("keeps lines for reloads, and forgets them once the real transcript is done or the meeting is deleted", () => {
    const bus = new EventBus();
    const live = new LiveTranscriptService(bus);
    live.add("a", line(1));
    live.add("a", line(2));
    expect(live.get("a")).toHaveLength(2);
    bus.publish({ type: "meeting", meeting: { ...newMeeting("a", "Zoom", "x", new Date()), transcript: "running" } });
    expect(live.get("a")).toHaveLength(2);
    bus.publish({ type: "meeting", meeting: { ...newMeeting("a", "Zoom", "x", new Date()), transcript: "done" } });
    expect(live.get("a")).toEqual([]);
    live.add("b", line(1));
    bus.publish({ type: "meetingDeleted", id: "b" });
    expect(live.get("b")).toEqual([]);
  });

  it("is bounded: the two most recent meetings, 5,000 lines each", () => {
    const live = new LiveTranscriptService(new EventBus());
    for (const id of ["a", "b", "c"]) live.add(id, line(0));
    expect(live.get("a")).toEqual([]);
    expect(live.get("c")).toHaveLength(1);
    for (let i = 0; i < 5_100; i++) live.add("c", line(i));
    expect(live.get("c")).toHaveLength(5_000);
  });
});
