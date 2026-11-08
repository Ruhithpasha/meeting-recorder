// Filesystem storage for meetings. No database: one folder per meeting.
//
//   ~/Meetings/
//     2026-11-08_14-30-05_zoom/
//       recording.mp4          written by the agent
//       meta.json              Meeting (see packages/shared/src/api.ts), written atomically
//       recording.state.json   exists only while recording; leftover = crashed, needs recovery
//
// An in-memory index (id -> Meeting, ids sorted newest first) is built once at boot and kept in
// sync on every write (write-through). fs.watch drops entries when folders are deleted by hand.
import { watch, type FSWatcher } from "node:fs";
import { access, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Meeting, MeetingPage } from "@meeting-recorder/shared";
import { writeJsonAtomic } from "../lib/fsAtomic.ts";
import { MEETING_ID_PATTERN, parseMeeting } from "../models/meeting.ts";

export interface RecordingState { app: string; title: string; startedAt: string }

export interface Logger { info(obj: unknown, msg?: string): void; warn(obj: unknown, msg?: string): void }

export class MeetingRepository {
  private readonly byId = new Map<string, Meeting>();
  private sortedIds: string[] = []; // newest first; ids sort chronologically
  private watcher: FSWatcher | null = null;
  readonly root: string;
  private readonly log: Logger;
  private readonly trashItem: (path: string) => Promise<void>;
  private readonly onExternalDelete: (id: string) => void;

  constructor(opts: {
    root: string;
    log: Logger;
    trashItem: (path: string) => Promise<void>;
    onExternalDelete?: (id: string) => void;
  }) {
    this.root = opts.root;
    this.log = opts.log;
    this.trashItem = opts.trashItem;
    this.onExternalDelete = opts.onExternalDelete ?? (() => {});
  }

  dir = (id: string) => join(this.root, id);
  recordingPath = (id: string) => join(this.root, id, "recording.mp4");
  private metaPath = (id: string) => join(this.root, id, "meta.json");
  private statePath = (id: string) => join(this.root, id, "recording.state.json");

  /** Builds the index from disk. Corrupt or foreign folders are logged and skipped, never fatal. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !MEETING_ID_PATTERN.test(entry.name)) continue;
      const meeting = await this.readMeta(entry.name);
      if (meeting) this.byId.set(meeting.id, meeting);
    }
    this.sortedIds = [...this.byId.keys()].sort().reverse();
  }

  /** Watches for folders removed outside the app (Finder, rm). */
  startWatching(): void {
    this.watcher = watch(this.root, (_event, name) => {
      if (!name || !this.byId.has(name)) return;
      access(this.dir(name)).catch(() => {
        this.remove(name);
        this.onExternalDelete(name);
      });
    });
    this.watcher.on("error", (error) => this.log.warn({ error }, "meetings folder watch failed"));
  }

  stopWatching(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  get(id: string): Meeting | undefined {
    return this.byId.get(id);
  }

  /** Cursor pagination, newest first. The cursor is the last id of the previous page. */
  list(cursor: string | undefined, limit: number): MeetingPage {
    const start = cursor === undefined ? 0 : this.firstIndexOlderThan(cursor);
    const ids = this.sortedIds.slice(start, start + limit);
    const items = ids.map((id) => this.byId.get(id)).filter((m): m is Meeting => m !== undefined);
    const hasMore = start + limit < this.sortedIds.length;
    return { items, nextCursor: hasMore && ids.length ? ids[ids.length - 1]! : null };
  }

  /** Creates the folder, meta.json and the state file. Returns false if the folder already exists. */
  async create(meeting: Meeting): Promise<boolean> {
    try {
      await mkdir(this.dir(meeting.id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    const state: RecordingState = { app: meeting.app, title: meeting.title, startedAt: meeting.startedAt };
    await writeJsonAtomic(this.statePath(meeting.id), state);
    await this.save(meeting);
    return true;
  }

  async save(meeting: Meeting): Promise<void> {
    await writeJsonAtomic(this.metaPath(meeting.id), meeting);
    if (!this.byId.has(meeting.id)) this.insertSorted(meeting.id);
    this.byId.set(meeting.id, meeting);
  }

  async readState(id: string): Promise<RecordingState | null> {
    try {
      const raw = JSON.parse(await readFile(this.statePath(id), "utf8")) as Partial<RecordingState>;
      if (typeof raw.app === "string" && typeof raw.title === "string" && typeof raw.startedAt === "string") {
        return { app: raw.app, title: raw.title, startedAt: raw.startedAt };
      }
    } catch { /* missing or corrupt: caller falls back to meta.json */ }
    return null;
  }

  async removeState(id: string): Promise<void> {
    await rm(this.statePath(id), { force: true });
  }

  /** Meeting folders that still have a state file (crashed or currently recording), oldest first. */
  async idsWithState(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !MEETING_ID_PATTERN.test(entry.name)) continue;
      try {
        await access(this.statePath(entry.name));
        ids.push(entry.name);
      } catch { /* no state file: finished normally */ }
    }
    return ids.sort();
  }

  /** Size of recording.mp4, or null if it doesn't exist. */
  async recordingSize(id: string): Promise<number | null> {
    try {
      return (await stat(this.recordingPath(id))).size;
    } catch {
      return null;
    }
  }

  /** Permanently removes a folder the app created but never recorded into (failed start). */
  async deleteFolder(id: string): Promise<void> {
    await this.removeThen(id, () => rm(this.dir(id), { recursive: true, force: true }));
  }

  /** Moves a meeting to the OS trash so a mistaken delete can be undone in Finder. */
  async trash(id: string): Promise<void> {
    await this.removeThen(id, () => this.trashItem(this.dir(id)));
  }

  /**
   * Drops the meeting from the index BEFORE touching disk, so the fs.watch handler (which only
   * reacts to indexed ids) doesn't report our own delete as an external one. Restored on failure.
   */
  private async removeThen(id: string, action: () => Promise<unknown>): Promise<void> {
    const meeting = this.byId.get(id);
    this.remove(id);
    try {
      await action();
    } catch (error) {
      if (meeting) { this.byId.set(id, meeting); this.insertSorted(id); }
      throw error;
    }
  }

  private async readMeta(id: string): Promise<Meeting | null> {
    try {
      const meeting = parseMeeting(JSON.parse(await readFile(this.metaPath(id), "utf8")), id);
      if (!meeting) this.log.warn({ id }, "skipping meeting with invalid meta.json");
      return meeting;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn({ id, error }, "skipping unreadable meta.json");
      return null;
    }
  }

  private remove(id: string): void {
    if (!this.byId.delete(id)) return;
    const i = this.sortedIds.indexOf(id);
    if (i >= 0) this.sortedIds.splice(i, 1);
  }

  /** Binary search: index of the first id strictly older (smaller) than `cursor`. */
  private firstIndexOlderThan(cursor: string): number {
    let lo = 0, hi = this.sortedIds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sortedIds[mid]! >= cursor) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private insertSorted(id: string): void {
    const i = this.firstIndexOlderThan(id);
    this.sortedIds.splice(i, 0, id);
  }
}
