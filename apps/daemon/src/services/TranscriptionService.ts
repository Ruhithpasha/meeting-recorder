// Background job: transcribe finished meetings on this Mac, one at a time, newest first.
//
//   pending set (built once at boot, kept in sync from meeting events: no scans on the hot path)
//      │
//   pump() ──▶ gates: enabled · transcriber present · recorder idle · on AC power · nothing running
//      └─▶ newest pending meeting ─▶ spawn MeetingRecorderTranscriber (stderr discarded, watchdog)
//             exit 0 + transcript.json ─▶ "done"     exit 3 ─▶ unavailable (macOS < 26 / language)
//             anything else ─▶ retry (max 3) ─▶ "failed" (manual Retry resets)
//
// Cancelled (and requeued) when a recording starts, the Mac is unplugged, transcription is turned
// off, or the meeting is deleted. "running" left by a crash is reset to "queued" at boot, so a
// daemon restart loses nothing. No audio ever leaves the Mac.
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Meeting, Settings, TranscriptStatus } from "@meeting-recorder/shared";
import { conflict, notFound } from "../lib/errors.ts";
import type { Logger, MeetingRepository } from "../repositories/MeetingRepository.ts";
import type { EventBus } from "./EventBus.ts";
import type { RecordingService } from "./RecordingService.ts";

export const MAX_ATTEMPTS = 3;
const EXIT_UNAVAILABLE = 3;
/** Watchdog: twice the recording's length plus 10 minutes (transcription runs far faster). */
export const timeoutMs = (durationSec: number | null) => ((durationSec ?? 3600) * 2 + 600) * 1000;

export type Spawner = (command: string, args: string[]) => ChildProcess;

export interface TranscriptionDeps {
  repo: MeetingRepository;
  bus: EventBus;
  recording: RecordingService;
  settings: () => Settings;
  log: Logger;
  /** Path of MeetingRecorderTranscriber (inside the app bundle); null when not installed. */
  transcriberPath: string | null;
  spawner?: Spawner;
}

type Job = { id: string; child: ChildProcess | null; cancelled: boolean; timedOut: boolean };

const eligible = (m: Meeting) =>
  (m.status === "complete" || m.status === "recovered") && (m.transcript === "none" || m.transcript === "queued");

export class TranscriptionService {
  private power: "ac" | "battery" | "unknown" = "unknown";
  /** Reserved synchronously in pump() (before any await), so two triggers can't start two jobs. */
  private running: Job | null = null;
  private readonly pending = new Set<string>();
  private readonly failures = new Map<string, number>();
  private unavailableReason: string | null = null;
  private readonly unsubscribe: () => void;
  private readonly d: TranscriptionDeps;

  constructor(deps: TranscriptionDeps) {
    this.d = deps;
    if (!deps.transcriberPath) this.unavailableReason = "Transcription isn't installed.";
    this.unsubscribe = deps.bus.subscribe((event) => {
      if (event.type === "meeting") {
        if (eligible(event.meeting)) this.pending.add(event.meeting.id);
        else this.pending.delete(event.meeting.id);
      } else if (event.type === "meetingDeleted") {
        this.pending.delete(event.id);
        if (this.running?.id === event.id) this.cancelRunning();
      } else if (event.status.state !== "idle") {
        this.cancelRunning(); // a recording is starting: don't compete with it
      } else {
        this.pump();
      }
    });
  }

  /** Boot: reset jobs interrupted by a crash or update, and build the pending set (one scan). */
  async init(): Promise<void> {
    for (let cursor: string | undefined; ;) {
      const page = this.d.repo.list(cursor, 500);
      for (const m of page.items) {
        if (m.transcript === "running") await this.setTranscript(m, "queued");
        else if (eligible(m)) this.pending.add(m.id);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  get unavailable(): string | null { return this.unavailableReason; }

  setPower(state: "ac" | "battery"): void {
    this.power = state;
    if (state === "battery") this.cancelRunning();
    else this.pump();
  }

  /** Settings changed: stop a running job when transcription was turned off, else maybe start. */
  settingsChanged(): void {
    if (!this.d.settings().transcription.enabled) this.cancelRunning();
    else this.pump();
  }

  /** Manual (re)queue from the dashboard. */
  async enqueue(id: string): Promise<Meeting> {
    const meeting = this.d.repo.get(id);
    if (!meeting) throw notFound("Meeting");
    if (meeting.status !== "complete" && meeting.status !== "recovered") throw conflict("Only saved recordings can be transcribed.");
    if (this.unavailableReason) throw conflict(this.unavailableReason);
    this.failures.delete(id);
    const queued = await this.setTranscript(meeting, "queued");
    this.pump();
    return queued;
  }

  /** Starts the next job if every gate is open. Cheap: no disk scans. Safe to call at any time. */
  pump(): void {
    if (this.running || this.unavailableReason || this.power !== "ac") return;
    if (!this.d.settings().transcription.enabled || this.d.recording.stateName !== "idle") return;
    const busy = this.d.recording.busyMeetingIds;
    const id = [...this.pending].filter((p) => !busy.has(p)).sort().at(-1); // ids sort chronologically
    if (!id) return;
    const meeting = this.d.repo.get(id);
    if (!meeting) { this.pending.delete(id); return this.pump(); }
    const job: Job = { id: meeting.id, child: null, cancelled: false, timedOut: false };
    this.running = job;
    void this.run(meeting, job).catch((error: unknown) => {
      if (this.running === job) this.running = null;
      this.d.log.warn({ error }, "transcription job crashed");
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.cancelRunning();
  }

  private async run(meeting: Meeting, job: Job): Promise<void> {
    const dir = this.d.repo.dir(meeting.id);
    await this.setTranscript(meeting, "running");
    // stderr is discarded: an unread pipe fills up and would block the transcriber forever.
    const spawner = this.d.spawner ?? ((cmd, args) => spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }));
    const child = spawner(this.d.transcriberPath!, [this.d.repo.recordingPath(meeting.id), dir]);
    job.child = child;
    if (job.cancelled) child.kill("SIGTERM"); // cancelled while we were getting ready
    const watchdog = setTimeout(() => { job.timedOut = true; child.kill("SIGKILL"); }, timeoutMs(meeting.durationSec));

    let lastError: string | null = null;
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const msg = JSON.parse(line) as { error?: string };
          if (msg.error) lastError = msg.error;
        } catch { /* ignore non-JSON output */ }
      });
    }
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (exitCode) => resolve(exitCode));
      child.on("error", () => resolve(null));
    });
    clearTimeout(watchdog);
    this.running = null;

    const current = this.d.repo.get(meeting.id);
    if (!current) return this.pump(); // deleted meanwhile
    if (job.cancelled) {
      await this.setTranscript(current, "queued");
    } else if (code === 0 && (await this.exists(join(dir, "transcript.json")))) {
      this.failures.delete(meeting.id);
      await this.setTranscript(current, "done");
      this.d.log.info({ id: meeting.id }, "transcribed");
    } else if (code === EXIT_UNAVAILABLE) {
      this.unavailableReason = lastError ?? "Transcription isn't available on this Mac.";
      await this.setTranscript(current, "none");
    } else {
      const attempts = (this.failures.get(meeting.id) ?? 0) + 1;
      this.failures.set(meeting.id, attempts);
      await this.setTranscript(current, attempts >= MAX_ATTEMPTS ? "failed" : "queued");
      this.d.log.warn({ id: meeting.id, code, attempts, timedOut: job.timedOut, error: lastError }, "transcription failed");
    }
    this.pump();
  }

  private cancelRunning(): void {
    if (!this.running) return;
    this.running.cancelled = true;
    this.running.child?.kill("SIGTERM");
  }

  private async setTranscript(meeting: Meeting, transcript: TranscriptStatus): Promise<Meeting> {
    const next = { ...meeting, transcript };
    await this.d.repo.save(next);
    this.d.bus.publish({ type: "meeting", meeting: next }); // also keeps `pending` in sync
    return next;
  }

  private async exists(path: string): Promise<boolean> {
    try { await access(path); return true; } catch { return false; }
  }
}
