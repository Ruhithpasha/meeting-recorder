import { describe, expect, it } from "vitest";
import { meeting } from "../test/fixtures.ts";
import { initialMeetings, meetingsReducer, type MeetingsState } from "./meetingsReducer.ts";

const loaded = (ids: number[], nextCursor: string | null = null): MeetingsState =>
  meetingsReducer(initialMeetings, { type: "pageLoaded", page: { items: ids.map((n) => meeting(n)), nextCursor }, append: false });

describe("meetingsReducer", () => {
  it("first page replaces, later pages append without duplicates", () => {
    let s = loaded([5, 4], meeting(4).id);
    expect(s.phase).toBe("ready");
    s = meetingsReducer(s, { type: "pageLoaded", page: { items: [meeting(4), meeting(3)], nextCursor: null }, append: true });
    expect(s.items.map((m) => m.title)).toEqual(["Meeting 5", "Meeting 4", "Meeting 3"]);
    expect(s.nextCursor).toBeNull();
  });

  it("a failed first load shows the error state; a failed 'load more' keeps the list", () => {
    expect(meetingsReducer(initialMeetings, { type: "loadFailed", error: "boom" })).toMatchObject({ phase: "error", error: "boom" });
    const s = meetingsReducer(loaded([2]), { type: "loadFailed", error: "boom" });
    expect(s).toMatchObject({ phase: "ready", error: "boom" });
    expect(s.items).toHaveLength(1);
  });

  it("live 'meeting' events update in place or insert in order", () => {
    let s = loaded([4, 2]);
    s = meetingsReducer(s, { type: "event", event: { type: "meeting", meeting: meeting(2, { status: "recovered" }) } });
    expect(s.items[1]!.status).toBe("recovered");
    s = meetingsReducer(s, { type: "event", event: { type: "meeting", meeting: meeting(3) } });
    s = meetingsReducer(s, { type: "event", event: { type: "meeting", meeting: meeting(9) } });
    expect(s.items.map((m) => m.title)).toEqual(["Meeting 9", "Meeting 4", "Meeting 3", "Meeting 2"]);
  });

  it("ignores live meetings older than the loaded window (they arrive with 'load more')", () => {
    const s = meetingsReducer(loaded([5, 4], meeting(4).id), { type: "event", event: { type: "meeting", meeting: meeting(1) } });
    expect(s.items).toHaveLength(2);
  });

  it("events that arrive while the first page loads survive the (older) snapshot", () => {
    let s = meetingsReducer(initialMeetings, { type: "loadStart" });
    s = meetingsReducer(s, { type: "event", event: { type: "meeting", meeting: meeting(9) } });
    s = meetingsReducer(s, { type: "event", event: { type: "meeting", meeting: meeting(2, { status: "recovered" }) } });
    s = meetingsReducer(s, { type: "pageLoaded", page: { items: [meeting(2), meeting(1)], nextCursor: null }, append: false });
    expect(s.items.map((m) => m.title)).toEqual(["Meeting 9", "Meeting 2", "Meeting 1"]);
    expect(s.items[1]!.status).toBe("recovered");
    expect(s.buffered).toEqual([]);
  });

  it("a resync keeps the list visible (no spinner flash)", () => {
    const s = meetingsReducer(loaded([1]), { type: "loadStart" });
    expect(s.phase).toBe("ready");
    expect(s.refreshing).toBe(true);
  });

  it("removes deleted meetings; ignores status events", () => {
    let s = meetingsReducer(loaded([3, 2]), { type: "event", event: { type: "meetingDeleted", id: meeting(3).id } });
    expect(s.items.map((m) => m.title)).toEqual(["Meeting 2"]);
    const before = s;
    s = meetingsReducer(s, { type: "event", event: { type: "status", status: { state: "idle", meetingId: null, agentConnected: true, warning: null } } });
    expect(s).toBe(before);
  });
});
