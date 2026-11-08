// Finalizes meetings whose recording was interrupted (crash, kill -9, power loss).
//
// A leftover recording.state.json means meta.json was never finalized. For each one:
//   inspect recording.mp4 → truncate the unfinished tail → write meta.json (status "recovered")
//   → remove the state file. No recording file at all → the folder is deleted.
//
// Runs only AFTER the agent's hello, skipping the meeting the agent says it is still recording,
// so a daemon restart mid-recording never truncates a live file.
import { truncate } from "node:fs/promises";
import type { Meeting } from "@meeting-recorder/shared";
import { inspectMp4 } from "../lib/mp4.ts";
import { newMeeting } from "../models/meeting.ts";
import type { Logger, MeetingRepository } from "../repositories/MeetingRepository.ts";

export class RecoveryService {
  private readonly repo: MeetingRepository;
  private readonly log: Logger;

  constructor(repo: MeetingRepository, log: Logger) {
    this.repo = repo;
    this.log = log;
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

  /** Returns the recovered meeting, or null if there was nothing to recover (folder removed). */
  async recoverOne(id: string): Promise<Meeting | null> {
    const path = this.repo.recordingPath(id);
    const size = await this.repo.recordingSize(id);
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
