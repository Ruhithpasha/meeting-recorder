import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { silentLog, tempDirs } from "../../test/helpers/harness.ts";
import { newMeeting } from "../models/meeting.ts";
import { MeetingRepository } from "./MeetingRepository.ts";

const id = (n: number) => `2026-11-${String(1 + Math.floor(n / 1000)).padStart(2, "0")}_10-00-${String(n % 60).padStart(2, "0")}_m${n}`;

async function repoWith(count: number) {
  const dirs = tempDirs();
  const repo = new MeetingRepository({ root: dirs.meetingsDir, log: silentLog, trashItem: async () => {} });
  await repo.init();
  for (let i = 0; i < count; i++) await repo.create(newMeeting(id(i), "Zoom", `m${i}`, new Date()));
  return { repo, dirs };
}

describe("MeetingRepository", () => {
  it("lists newest first with stable cursor pages", async () => {
    const { repo } = await repoWith(7);
    const sorted = Array.from({ length: 7 }, (_, i) => id(i)).sort().reverse();
    const p1 = repo.list(undefined, 3);
    const p2 = repo.list(p1.nextCursor!, 3);
    const p3 = repo.list(p2.nextCursor!, 3);
    expect([...p1.items, ...p2.items, ...p3.items].map((m) => m.id)).toEqual(sorted);
    expect(p3.nextCursor).toBeNull();
  });

  it("a meeting inserted mid-pagination does not shift later pages", async () => {
    const { repo } = await repoWith(4);
    const p1 = repo.list(undefined, 2);
    await repo.create(newMeeting("2099-01-01_00-00-00_new", "Zoom", "new", new Date()));
    const p2 = repo.list(p1.nextCursor!, 2);
    expect(p2.items.map((m) => m.id)).not.toContain(p1.items[1]!.id);
    expect(p2.items).toHaveLength(2);
  });

  it("empty folder: empty page", async () => {
    const { repo } = await repoWith(0);
    expect(repo.list(undefined, 50)).toEqual({ items: [], nextCursor: null });
  });

  it("rebuilds the index from disk, skipping corrupt meta.json and foreign folders", async () => {
    const { repo, dirs } = await repoWith(2);
    mkdirSync(join(dirs.meetingsDir, "2026-11-09_10-00-00_bad"));
    writeFileSync(join(dirs.meetingsDir, "2026-11-09_10-00-00_bad", "meta.json"), "{not json");
    mkdirSync(join(dirs.meetingsDir, "Holiday photos"));
    const warn = vi.fn();
    const fresh = new MeetingRepository({ root: dirs.meetingsDir, log: { info() {}, warn }, trashItem: async () => {} });
    await fresh.init();
    expect(fresh.list(undefined, 50).items.map((m) => m.id).sort()).toEqual([id(0), id(1)].sort());
    expect(warn).toHaveBeenCalled();
    void repo;
  });

  it("create refuses an existing folder (caller picks a new id)", async () => {
    const { repo } = await repoWith(0);
    const m = newMeeting(id(1), "Zoom", "x", new Date());
    expect(await repo.create(m)).toBe(true);
    expect(await repo.create(m)).toBe(false);
  });

  it("drops a folder deleted outside the app (fs.watch)", async () => {
    const { dirs } = await repoWith(0);
    const deleted: string[] = [];
    const repo = new MeetingRepository({ root: dirs.meetingsDir, log: silentLog, trashItem: async () => {}, onExternalDelete: (i) => deleted.push(i) });
    await repo.init();
    await repo.create(newMeeting(id(3), "Zoom", "x", new Date()));
    repo.startWatching();
    await new Promise((r) => setTimeout(r, 250)); // FSEvents needs a moment before it reports changes
    rmSync(join(dirs.meetingsDir, id(3)), { recursive: true });
    await vi.waitFor(() => expect(deleted).toEqual([id(3)]), { timeout: 3000 });
    expect(repo.get(id(3))).toBeUndefined();
    repo.stopWatching();
  });

  it("trash removes from the index", async () => {
    const trashItem = vi.fn(async () => {});
    const dirs = tempDirs();
    const repo = new MeetingRepository({ root: dirs.meetingsDir, log: silentLog, trashItem });
    await repo.init();
    await repo.create(newMeeting(id(5), "Zoom", "x", new Date()));
    await repo.trash(id(5));
    expect(trashItem).toHaveBeenCalledWith(join(dirs.meetingsDir, id(5)));
    expect(repo.get(id(5))).toBeUndefined();
  });

  it("a failed trash keeps the meeting in the index", async () => {
    const dirs = tempDirs();
    const repo = new MeetingRepository({ root: dirs.meetingsDir, log: silentLog, trashItem: async () => { throw new Error("EPERM"); } });
    await repo.init();
    await repo.create(newMeeting(id(6), "Zoom", "x", new Date()));
    await expect(repo.trash(id(6))).rejects.toThrow("EPERM");
    expect(repo.get(id(6))).toBeDefined();
    expect(repo.list(undefined, 10).items.map((m) => m.id)).toEqual([id(6)]);
  });

  it("our own deletes are not reported as external deletes (no duplicate events)", async () => {
    const dirs = tempDirs();
    const external: string[] = [];
    const { rm } = await import("node:fs/promises");
    const repo = new MeetingRepository({ root: dirs.meetingsDir, log: silentLog, trashItem: (p) => rm(p, { recursive: true }), onExternalDelete: (i) => external.push(i) });
    await repo.init();
    await repo.create(newMeeting(id(7), "Zoom", "x", new Date()));
    repo.startWatching();
    await repo.trash(id(7));
    await new Promise((r) => setTimeout(r, 300));
    expect(external).toEqual([]);
    repo.stopWatching();
  });

  it("pages 10,000 meetings quickly (binary-search cursor)", async () => {
    const dirs = tempDirs();
    const repo = new MeetingRepository({ root: dirs.meetingsDir, log: silentLog, trashItem: async () => {} });
    await repo.init();
    const ids = Array.from({ length: 10_000 }, (_, i) => `2026-${String(1 + (i % 12)).padStart(2, "0")}-01_00-00-00_m${i}`);
    // Seed the index without 10k disk writes: same code path as save(), minus the file.
    for (const m of ids) (repo as unknown as { insertSorted(id: string): void; byId: Map<string, unknown> }).byId.set(m, newMeeting(m, "Z", "x", new Date()));
    (repo as unknown as { sortedIds: string[] }).sortedIds = [...ids].sort().reverse();
    const t = performance.now();
    let cursor: string | undefined;
    let seen = 0;
    do { const page = repo.list(cursor, 100); seen += page.items.length; cursor = page.nextCursor ?? undefined; } while (cursor);
    expect(seen).toBe(10_000);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
