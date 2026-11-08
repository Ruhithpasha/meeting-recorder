// Turns a meeting's separately recorded streams into recording.mp4 (see the agent's
// RecordingParts.swift: video, system audio and mic each in their own crash-safe parts).
//
//   parts.json ─▶ each part: trim its unfinished tail (inspectMp4, as crash recovery does)
//              ─▶ MeetingRecorderTranscriber --merge <dir> (passthrough: seconds for an hour)
//              ─▶ recording.mp4 ─▶ parts and parts.json removed
//
// Runs after every stop, after a recorder error, and in crash recovery, so the same code path
// finishes every recording. If the merge fails the parts stay, and recovery tries again later.
import { readFile, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectMp4 } from "../lib/mp4.ts";
import type { Logger, MeetingRepository } from "../repositories/MeetingRepository.ts";
import { policySpawn, type Spawner } from "./TranscriptionService.ts";

export interface MergeDeps {
  repo: MeetingRepository;
  log: Logger;
  transcriberPath: string | null;
  spawner?: Spawner;
}

const MANIFEST = "parts.json";
const ATTEMPTS = "merge-attempts";
const MAX_ATTEMPTS = 3;

export type MergeResult = { status: "none" | "failed" | "gave-up" } | { status: "merged"; durationSec: number | null };
const PART_FILE = /^(video|system|mic)-[0-9]{1,4}\.mp4$/;
const MERGE_TIMEOUT_MS = 10 * 60 * 1000;
/** The user is waiting for their recording: utility priority, not background. */
const utilitySpawn = policySpawn(["-c", "utility"]);

export class MergeService {
  private readonly d: MergeDeps;

  constructor(deps: MergeDeps) {
    this.d = deps;
  }

  /** Merges the meeting's parts if it has any.
   *   none     a single-file recording: nothing to do
   *   merged   recording.mp4 is ready; the parts the helper used are removed
   *   failed   parts kept; try again later (crash recovery retries)
   *   gave-up  3 failed attempts, or no helper: parts kept for good, the meeting is finalized without
   *            a merged file so it never blocks recovery */
  async mergeParts(id: string): Promise<MergeResult> {
    const dir = this.d.repo.dir(id);
    let files: string[];
    try {
      const manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as { parts?: { file?: unknown }[] };
      files = [...new Set((manifest.parts ?? []).map((p) => p.file).filter((f): f is string => typeof f === "string" && PART_FILE.test(f)))];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
      this.d.log.warn({ id, error }, "parts.json unreadable; keeping the parts");
      return this.failure(id);
    }
    if (!this.d.transcriberPath) {
      this.d.log.warn({ id }, "recording parts can't be merged: the helper isn't installed");
      return { status: "gave-up" };
    }
    // Each part is a fragmented MP4: drop an unfinished tail (a writer that failed or a crash).
    for (const file of files) {
      const path = join(dir, file);
      try {
        const info = await inspectMp4(path);
        if (info.completeBytes < info.fileBytes) await truncate(path, info.completeBytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.d.log.warn({ id, file, error }, "couldn't inspect a recording part");
      }
    }
    const result = await this.run(["--merge", dir]);
    if (!result.ok) {
      this.d.log.warn({ id, error: result.error }, "merging the recording failed; parts kept");
      return this.failure(id);
    }
    // Only the parts the helper actually used are removed; anything else stays on disk.
    const used = result.merged.filter((f) => files.includes(f));
    await Promise.all([...used, MANIFEST, ATTEMPTS].map((f) => rm(join(dir, f), { force: true })));
    const kept = files.filter((f) => !used.includes(f));
    if (kept.length) this.d.log.warn({ id, kept }, "parts not used by the merge were kept");
    this.d.log.info({ id, parts: used.length, durationSec: result.durationSec }, "recording merged");
    return { status: "merged", durationSec: result.durationSec };
  }

  /** Counts a failed attempt (in the meeting folder, so it survives restarts). */
  private async failure(id: string): Promise<MergeResult> {
    const path = join(this.d.repo.dir(id), ATTEMPTS);
    const attempts = (Number.parseInt(await readFile(path, "utf8").catch(() => "0"), 10) || 0) + 1;
    await writeFile(path, String(attempts)).catch(() => {});
    return { status: attempts >= MAX_ATTEMPTS ? "gave-up" : "failed" };
  }

  private run(args: string[]): Promise<{ ok: true; durationSec: number | null; merged: string[] } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      const child = (this.d.spawner ?? utilitySpawn)(this.d.transcriberPath!, args);
      let output = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
      const timer = setTimeout(() => child.kill("SIGKILL"), MERGE_TIMEOUT_MS);
      let settled = false;
      const done = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const last = output.trim().split("\n").at(-1) ?? "";
        let msg: { error?: string; durationSec?: number; merged?: unknown } = {};
        try { msg = JSON.parse(last) as typeof msg; } catch { /* no JSON */ }
        const merged = Array.isArray(msg.merged) ? msg.merged.filter((f): f is string => typeof f === "string") : [];
        if (code === 0) resolve({ ok: true, durationSec: typeof msg.durationSec === "number" ? msg.durationSec : null, merged });
        else resolve({ ok: false, error: msg.error ?? `merge exited with ${code}` });
      };
      child.on("close", done);
      child.on("error", () => done(null));
    });
  }
}
