import { describe, expect, it } from "vitest";
import { MEETING_ID_PATTERN, meetingId, newMeeting, parseMeeting, sanitizeTitle, slugify } from "./meeting.ts";

describe("slugify", () => {
  it.each([
    ["Zoom", "zoom"],
    ["Microsoft Teams", "microsoft-teams"],
    ["  Google Meet!! ", "google-meet"],
    ["Café Ünïcode", "cafe-unicode"],
    ["日本語", "meeting"],
    ["", "meeting"],
    ["x".repeat(80), "x".repeat(40)],
  ])("%j -> %j", (input, out) => expect(slugify(input)).toBe(out));
});

describe("meetingId", () => {
  const at = new Date(2026, 10, 8, 14, 30, 5);
  it("is local date_time_slug and matches the shared schema pattern", () => {
    expect(meetingId(at, "Zoom")).toBe("2026-11-08_14-30-05_zoom");
    expect(MEETING_ID_PATTERN.test(meetingId(at, "Zoom"))).toBe(true);
  });
  it("suffixed ids stay within the 40-char slug limit", () => {
    const id = meetingId(at, "x".repeat(80), 3);
    expect(MEETING_ID_PATTERN.test(id)).toBe(true);
    expect(id.endsWith("-3")).toBe(true);
  });
  it.each(["../etc", "a/b", "Zoom", "2026-11-08_14-30-05_"])("pattern rejects %j", (bad) => {
    expect(MEETING_ID_PATTERN.test(bad)).toBe(false);
  });
});

describe("sanitizeTitle", () => {
  it("strips control and bidi characters, collapses whitespace, caps length", () => {
    expect(sanitizeTitle("Meet\u0000 -\n\t abc‮")).toBe("Meet - abc");
    expect(sanitizeTitle("a".repeat(500))).toHaveLength(120);
    expect(sanitizeTitle("\u0001\u0002")).toBe("Meeting");
  });
});

describe("parseMeeting", () => {
  const good = newMeeting("2026-11-08_14-30-05_zoom", "Zoom", "Sync", new Date("2026-11-08T14:30:05Z"));
  it("round-trips a valid meeting", () => {
    expect(parseMeeting(JSON.parse(JSON.stringify(good)), good.id)).toEqual(good);
  });
  it("rejects mismatched ids, missing fields, bad status", () => {
    expect(parseMeeting(good, "2026-11-08_14-30-05_other")).toBeNull();
    expect(parseMeeting({ ...good, app: 1 }, good.id)).toBeNull();
    expect(parseMeeting({ ...good, status: "weird" }, good.id)).toBeNull();
    expect(parseMeeting({ ...good, startedAt: "yesterday" }, good.id)).toBeNull();
    expect(parseMeeting(null, good.id)).toBeNull();
  });
  it("coerces bad optional fields instead of failing", () => {
    expect(parseMeeting({ ...good, durationSec: -5, sizeBytes: "big", transcript: "??" }, good.id))
      .toMatchObject({ durationSec: null, sizeBytes: null, transcript: "none", summary: "none" });
  });
});

describe("continuedTitle", () => {
  it("adds the suffix once, within the 120-character cap", async () => {
    const { continuedTitle } = await import("./meeting.ts");
    expect(continuedTitle("Standup")).toBe("Standup (continued)");
    expect(continuedTitle("Standup (continued)")).toBe("Standup (continued)");
    const long = continuedTitle("x".repeat(120));
    expect(long).toHaveLength(120);
    expect(long.endsWith(" (continued)")).toBe(true);
  });
});
