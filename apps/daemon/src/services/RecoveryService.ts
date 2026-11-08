// Finalizes meetings whose recording was interrupted (crash, kill -9, power loss).
//
// A leftover recording.state.json means meta.json was never finalized. For each one:
//   separately recorded streams? merge them (MergeService) into recording.mp4
//   inspect recording.mp4 → truncate the unfinished tail → write meta.json (status "recovered")
//   → remove the state file. No recording file at all → the folder is deleted.
//
// Runs only AFTER the agent's hello, skipping the meeting the agent says it is still recording,
// so a daemon restart mid-recording never truncates a live file.
import { truncate } from "node:fs/promises";
import type { Meeting } from "@meeting-recorder/shared";
import { inspectMp4 } from "../lib/mp4.ts";
import type { MergeService } from "./MergeService.ts";
import { newMeeting } from "../models/meeting.ts";
import type { Logger, MeetingRepository } from "../repositories/MeetingRepository.ts";

export class RecoveryService {
  private readonly repo: MeetingRepository;
  private readonly log: Logger;
  private readonly merge: Pick<MergeService, "mergeParts"> | null;

  constructor(repo: MeetingRepository, log: Logger, merge: Pick<MergeService, "mergeParts"> | null = null) {
    this.repo = repo;
    this.log = log;
    this.merge = merge;
  }

  /** Recovers every interrupted meeting except those in `skip` (live or in flight). */
  async run(skip: ReadonlySet<string> = new Set()): Promise<{ recovered: Meeting[]; deleted: string[] }> {
    const recovered: Meeting[] = [];
    const deleted: string[] = [];
    for (const id of await this.repo.idsWithState()) {
      if (skip.has(id)) continue;
      try {
        const meeting = await this.recoverOne(id);
        if (meeting) recovered.push(meeting);
        else deleted.push(id);
      } catch (error) {
        this.log.warn({ id, error }, "recovery failed; will retry on next start");
      }
    }
    return { recovered, deleted };
  }

  /** Parts that could never be merged: keep every file, show the meeting as recovered. */
  private async finalizeUnmerged(id: string): Promise<Meeting> {
    const state = await this.repo.readState(id);
    const base = this.repo.get(id)
      ?? (state ? newMeeting(id, state.app, state.title, new Date(state.startedAt)) : newMeeting(id, "Unknown", "Recovered meeting", new Date()));
    const meeting: Meeting = { ...base, status: "recovered", durationSec: null, endedAt: null, sizeBytes: null };
    await this.repo.save(meeting);
    await this.repo.removeState(id);
    this.log.warn({ id }, "recording parts couldn't be merged; kept as separate files in the meeting folder");
    return meeting;
  }

  /** Returns the recovered meeting, or null if there was nothing to recover (folder removed). */
  async recoverOne(id: string): Promise<Meeting | null> {
    // Separately recorded streams (parts.json) become recording.mp4 first. A merge that failed is
    // retried on the next start; one that gave up finalizes the meeting with its parts kept.
    const merge = this.merge ? await this.merge.mergeParts(id) : { status: "none" as const };
    if (merge.status === "failed") throw new Error("recording parts couldn't be merged yet");
    const path = this.repo.recordingPath(id);
    const size = await this.repo.recordingSize(id);
    if (!size && merge.status === "gave-up") return this.finalizeUnmerged(id);
    if (!size) {
      await this.repo.deleteFolder(id);
      this.log.info({ id }, "removed interrupted meeting with no recording data");
      return null;
    }

    const info = await inspectMp4(path);
    if (info.completeBytes < info.fileBytes) await truncate(path, info.completeBytes);

    const state = await this.repo.readState(id);
    const base = this.repo.get(id)
      ?? (state ? newMeeting(id, state.app, state.title, new Date(state.startedAt)) : newMeeting(id, "Unknown", "Recovered meeting", new Date()));
    const durationSec = info.durationSec === null ? null : Math.round(info.durationSec * 10) / 10;
    const endedAt = durationSec === null ? null : new Date(Date.parse(base.startedAt) + durationSec * 1000).toISOString();
    const meeting: Meeting = { ...base, status: "recovered", durationSec, endedAt, sizeBytes: info.completeBytes };

    await this.repo.save(meeting);
    await this.repo.removeState(id);
    this.log.info({ id, durationSec, truncatedBytes: info.fileBytes - info.completeBytes }, "recovered interrupted meeting");
    return meeting;
  }
}
