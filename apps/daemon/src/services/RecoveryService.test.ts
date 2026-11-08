import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appleFragmented } from "../../test/helpers/mp4Builder.ts";
import { makeContainer } from "../../test/helpers/harness.ts";
import { newMeeting } from "../models/meeting.ts";

const video = { id: 1, timescale: 600, initialDuration: 3000, defaultSampleDuration: 40 };
const fiveSec = Array<number>(75).fill(40);

async function interrupted(opts: { withMeta?: boolean; bytes?: Buffer | null; id?: string } = {}) {
  const ctx = await makeContainer();
  const id = opts.id ?? "2026-11-08_14-30-05_zoom";
  const dir = join(ctx.dirs.meetingsDir, id);
  const meeting = newMeeting(id, "Zoom", "Weekly sync", new Date("2026-11-08T14:30:05Z"));
  if (opts.withMeta ?? true) {
    await ctx.container.repo.create(meeting);
  } else {
    mkdirSync(dir);
    writeFileSync(join(dir, "recording.state.json"), JSON.stringify({ app: "Zoom", title: "Weekly sync", startedAt: meeting.startedAt }));
  }
  if (opts.bytes !== null) writeFileSync(join(dir, "recording.mp4"), opts.bytes ?? Buffer.alloc(0));
  return { ...ctx, id, dir };
}

describe("RecoveryService", () => {
  it("truncates the unfinished tail, sums durations, marks recovered, removes the state file", async () => {
    const { bytes, fragmentEnds } = appleFragmented({ tracks: [video], fragments: [[{ trackId: 1, sampleDurations: fiveSec }]], inProgressBytes: 4000 });
    const { container: c, id, dir } = await interrupted({ bytes });
    const { recovered } = await c.recovery.run();
    expect(recovered.map((m) => m.id)).toEqual([id]);
    expect(statSync(join(dir, "recording.mp4")).size).toBe(fragmentEnds[0]);
    expect(existsSync(join(dir, "recording.state.json"))).toBe(false);
    expect(c.repo.get(id)).toMatchObject({ status: "recovered", durationSec: 10, sizeBytes: fragmentEnds[0], title: "Weekly sync" });
    expect(c.repo.get(id)?.endedAt).toBe("2026-11-08T14:30:15.000Z");
  });

  it("skips the meeting the agent says is still recording", async () => {
    const { bytes } = appleFragmented({ tracks: [video], fragments: [], inProgressBytes: 4000 });
    const { container: c, id, dir } = await interrupted({ bytes });
    const before = statSync(join(dir, "recording.mp4")).size;
    expect(await c.recovery.run(new Set([id]))).toEqual({ recovered: [], deleted: [] });
    expect(statSync(join(dir, "recording.mp4")).size).toBe(before);
    expect(existsSync(join(dir, "recording.state.json"))).toBe(true);
  });

  it("rebuilds meta.json from the state file when meta is missing", async () => {
    const { bytes } = appleFragmented({ tracks: [video], fragments: [] });
    const { container: c, id, dir } = await interrupted({ bytes, withMeta: false });
    await c.recovery.run();
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toMatchObject({ id, app: "Zoom", title: "Weekly sync", status: "recovered", durationSec: 5 });
    expect(c.repo.list(undefined, 10).items.map((m) => m.id)).toEqual([id]);
  });

  it("deletes a folder whose recording never got any data", async () => {
    const { container: c, dir, id } = await interrupted({ bytes: null });
    expect(await c.recovery.run()).toEqual({ recovered: [], deleted: [id] });
    expect(existsSync(dir)).toBe(false);
  });

  it("leaves finished meetings alone", async () => {
    const { container: c, id, dir } = await interrupted({ bytes: Buffer.alloc(10) });
    await c.repo.removeState(id);
    expect(await c.recovery.run()).toEqual({ recovered: [], deleted: [] });
    expect(c.repo.get(id)?.status).toBe("recording"); // untouched (no state file)
    expect(existsSync(join(dir, "recording.mp4"))).toBe(true);
  });

  it("an unreadable file in one meeting doesn't stop recovery of the others", async () => {
    const { bytes } = appleFragmented({ tracks: [video], fragments: [] });
    const ctx = await interrupted({ bytes });
    const otherId = "2026-11-08_15-00-00_teams";
    const otherDir = join(ctx.dirs.meetingsDir, otherId);
    await ctx.container.repo.create(newMeeting(otherId, "Teams", "x", new Date()));
    mkdirSync(join(otherDir, "recording.mp4")); // a directory where a file should be: inspect throws
    writeFileSync(join(otherDir, "recording.mp4", "x"), "x");
    const { recovered } = await ctx.container.recovery.run();
    expect(recovered.map((m) => m.id)).toEqual([ctx.id]);
  });
});
