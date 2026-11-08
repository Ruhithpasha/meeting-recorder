// Share a meeting through the macOS share sheet (AirDrop, Mail, Messages…). Nothing is uploaded
// by us: the menu-bar app shows the system sheet and the user picks where it goes.
//
//   what      file shared            notes
//   video     share.mp4              smaller copy, both sides mixed into one audio track; made on
//                                    first request (MeetingRecorderTranscriber --export), then reused
//   original  recording.mp4          full quality, separate audio tracks (QuickTime plays both)
//   summary   summary.md
//
// One copy is made at a time, at background priority. Progress reaches the dashboard as
// {type:"share"} events. A copy older than its recording is remade.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Meeting, ShareWhat } from "@meeting-recorder/shared";
import { conflict, notFound } from "../lib/errors.ts";
import type { AgentPort } from "../agent/AgentChannel.ts";
import type { Logger, MeetingRepository } from "../repositories/MeetingRepository.ts";
import type { EventBus } from "./EventBus.ts";
import type { RecordingService } from "./RecordingService.ts";
import { backgroundSpawn, type Spawner } from "./TranscriptionService.ts";

export interface ShareDeps {
  repo: MeetingRepository;
  bus: EventBus;
  agent: AgentPort;
  recording: Pick<RecordingService, "stateName">;
  log: Logger;
  transcriberPath: string | null;
  spawner?: Spawner;
}

const COPY_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export class ShareService {
  private exporting: { id: string; kill: () => void; stop: (reason: string) => void } | null = null;
  private readonly unsubscribe: () => void;

  private readonly d: ShareDeps;

  constructor(deps: ShareDeps) {
    this.d = deps;
    // A deleted meeting's copy is pointless, and a recording must never compete with a
    // re-encode (dropped frames on small Macs): stop the copy in both cases.
    this.unsubscribe = deps.bus.subscribe((event) => {
      if (!this.exporting) return;
      if (event.type === "meetingDeleted" && this.exporting.id === event.id) this.exporting.kill();
      if (event.type === "status" && event.status.state !== "idle") this.exporting.stop("Stopped because a recording started. Share it again after the call.");
    });
  }

  /** "shared": the share sheet is open. "exporting": the copy is being made; it opens when done. */
  async share(id: string, what: ShareWhat): Promise<{ state: "shared" | "exporting" }> {
    const meeting = this.d.repo.get(id);
    if (!meeting) throw notFound("Meeting");
    if (meeting.status !== "complete" && meeting.status !== "recovered") throw conflict("Only saved recordings can be shared.");
    if (what === "summary") {
      if (meeting.summary !== "done") throw conflict("This meeting has no summary yet.");
      return this.open(meeting, "summary.md");
    }
    if (what === "original") return this.open(meeting, "recording.mp4");

    if (await this.copyIsFresh(meeting)) return this.open(meeting, "share.mp4");
    if (this.exporting?.id === id) return { state: "exporting" };
    if (this.exporting) throw conflict("A copy of another meeting is being made. Try again when it's done.");
    if (this.d.recording.stateName !== "idle") throw conflict("A smaller copy can be made after the recording ends. You can share the original now.");
    if (!this.d.transcriberPath) throw conflict("Making a smaller copy isn't available: the helper isn't installed.");
    this.export(meeting);
    return { state: "exporting" };
  }

  dispose(): void {
    this.unsubscribe();
    this.exporting?.kill();
  }

  private open(meeting: Meeting, file: "recording.mp4" | "share.mp4" | "summary.md"): { state: "shared" } {
    this.d.agent.send({ cmd: "share", meetingId: meeting.id, file });
    return { state: "shared" };
  }

  private async copyIsFresh(meeting: Meeting): Promise<boolean> {
    try {
      const dir = this.d.repo.dir(meeting.id);
      const [copy, original] = await Promise.all([stat(join(dir, "share.mp4")), stat(join(dir, "recording.mp4"))]);
      return copy.mtimeMs >= original.mtimeMs;
    } catch {
      return false;
    }
  }

  /** Reserved synchronously (before any await), so two clicks can't start two copies. */
  private export(meeting: Meeting): void {
    const dir = this.d.repo.dir(meeting.id);
    const child = (this.d.spawner ?? backgroundSpawn)(this.d.transcriberPath!, ["--export", join(dir, "recording.mp4"), join(dir, "share.mp4")]);
    let stoppedFor: string | undefined;
    const job = {
      id: meeting.id,
      kill: () => { child.kill("SIGTERM"); },
      stop: (reason: string) => { stoppedFor = reason; child.kill("SIGTERM"); },
    };
    this.exporting = job;
    const publish = (state: "exporting" | "ready" | "failed", extra: { percent?: number; error?: string } = {}) =>
      this.d.bus.publish({ type: "share", id: meeting.id, state, ...extra });
    publish("exporting", { percent: 0 });

    let lastError: string | undefined;
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => { // whole lines, however the pipe splits them
        try {
          const msg = JSON.parse(line) as { percent?: number; error?: string };
          if (typeof msg.percent === "number") publish("exporting", { percent: msg.percent });
          if (msg.error) lastError = msg.error;
        } catch { /* non-JSON line */ }
      });
    }
    const timer = setTimeout(job.kill, COPY_TIMEOUT_MS);
    let finished = false;
    const done = (code: number | null) => {
      if (finished) return; // "error" can be followed by "exit": report once
      finished = true;
      clearTimeout(timer);
      if (this.exporting === job) this.exporting = null;
      if (code === 0 && !stoppedFor && this.d.repo.get(meeting.id)) {
        publish("ready");
        this.open(meeting, "share.mp4");
      } else {
        this.d.log.warn({ id: meeting.id, code, error: lastError, stoppedFor }, "share copy failed");
        publish("failed", { error: stoppedFor ?? lastError ?? "The smaller copy couldn't be made." });
      }
    };
    child.on("close", done); // after stdout is drained
    child.on("error", () => done(null));
  }
}
