import { describe, expect, it } from "vitest";
import { formatBytes, formatDateTime, formatDuration } from "./format.ts";

describe("format", () => {
  it.each([[0, "0:00"], [75, "1:15"], [3725, "1:02:05"], [59.6, "1:00"], [null, "—"], [-1, "—"], [Number.NaN, "—"]])(
    "duration %s -> %s", (input, out) => expect(formatDuration(input)).toBe(out));
  it.each([[0, "0 B"], [1536, "1.5 KB"], [734003200, "700 MB"], [5 * 1024 ** 3, "5.0 GB"], [null, "—"]])(
    "bytes %s -> %s", (input, out) => expect(formatBytes(input)).toBe(out));
  it("formats dates and passes through garbage", () => {
    expect(formatDateTime("2026-11-08T14:30:00Z", "en-GB")).toMatch(/8 Nov 2026/);
    expect(formatDateTime("not a date")).toBe("not a date");
  });
});
