// Background jobs on finished meetings, on this Mac, one at a time, newest first:
//   1. transcribe (SpeechTranscriber)  ─▶ transcript.json      meeting.transcript
//   2. summarize  (Foundation Models)  ─▶ summary.json/.md     meeting.summary (after 1)
//
//   pending: meeting id ─▶ next job kind (built once at boot, kept in sync from meeting events)
//   pump() ──▶ gates: recorder idle · power known (battery is fine) · nothing running · kind allowed and available
//      └─▶ newest pending meeting ─▶ spawn MeetingRecorderTranscriber [--summarize] (watchdog)
//
//   transcriber exit code ─▶ outcome
//     0 + new output   done (a redone transcript re-queues the meeting's summary, if it had one)
//     3                unavailable on this Mac (OS, language, Apple Intelligence off); re-checked
//                      after 30 min or when settings change
//     5                not ready yet (model downloading): queued again, retried in 10 min
//     6                impossible for this input (model declined): failed now, reason shown
//     other            retried up to 3 times, then failed (manual Retry resets)
//
// Automatic jobs follow the settings; jobs the user asks for ("Transcribe/Summarize now",
// Retry) run even when the automatic setting is off. Cancelled (requeued) when a recording
// starts or the meeting is deleted. "running" left by a crash is reset
// at boot, so nothing is lost. No audio or text ever leaves the Mac.
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Meeting, Settings, TranscriptStatus } from "@meeting-recorder/shared";
import { conflict, notFound } from "../lib/errors.ts";
import type { Logger, MeetingRepository } from "../repositories/MeetingRepository.ts";
import type { EventBus } from "./EventBus.ts";
import type { RecordingService } from "./RecordingService.ts";

export const MAX_ATTEMPTS = 3;
export const UNAVAILABLE_RECHECK_MS = 30 * 60_000;
export const NOT_READY_RETRY_MS = 10 * 60_000;
/** Watchdog: twice the recording's length plus 10 minutes (both jobs run far faster). */
export const timeoutMs = (durationSec: number | null) => ((durationSec ?? 3600) * 2 + 600) * 1000;

export type Spawner = (command: string, args: string[]) => ChildProcess;

/** Background priority (efficiency cores, low I/O priority) so jobs never slow the Mac down.
 *  taskpolicy execs the program, so the pid is the transcriber's own. It leads its own process
 *  group and kill() signals the whole group, so helpers it starts (llama.cpp) stop with it, even
 *  on SIGKILL. stderr is discarded: an unread pipe fills up and would block the transcriber. */
export const policySpawn = (policy: string[]): Spawner => (cmd, args) => {
  const child = spawn("/usr/sbin/taskpolicy", [...policy, cmd, ...args], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  child.kill = (signal: NodeJS.Signals | number = "SIGTERM") => {
    if (!child.pid) return false; // never started
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false; // already gone
    }
  };
  return child;
};
export const backgroundSpawn = policySpawn(["-b"]);

/** Command-line arguments for one job (see MeetingRecorderTranscriber's usage). */
export function jobArgs(kind: JobKind, recording: string, dir: string, t: Settings["transcription"], modelsDir?: string): string[] {
  const engine = kind === "transcript" ? t.engine : t.summaryEngine;
  const open = engine !== "apple" ? ["--engine", engine, ...(modelsDir ? ["--models", modelsDir] : [])] : [];
  return kind === "transcript"
    ? [recording, dir, ...(t.language === "auto" ? [] : ["--locale", t.language]), ...open]
    : ["--summarize", dir, ...open];
}
export type JobKind = "transcript" | "summary";

export interface TranscriptionDeps {
  repo: MeetingRepository;
  bus: EventBus;
  recording: RecordingService;
  settings: () => Settings;
  log: Logger;
  /** Path of MeetingRecorderTranscriber (inside the app bundle); null when not installed. */
  transcriberPath: string | null;
  /** Where open models are downloaded once (Hugging Face) and kept. */
  modelsDir?: string;
  /** True while that open model is being downloaded: its jobs wait (ModelService resumes them). */
  modelBusy?: (engine: "whisper" | "qwen") => boolean;
  spawner?: Spawner;
  now?: () => number;
}

type Job = { id: string; kind: JobKind; child: ChildProcess | null; cancelled: boolean; timedOut: boolean; startedAt: number };
type Block = { reason: string; until: number };

/** The file whose (re)write marks a finished job. */
const OUTPUT: Record<JobKind, string> = { transcript: "transcript.json", summary: "summary.json" };
const ERROR_FIELD = { transcript: "transcriptError", summary: "summaryError" } as const;
const saved = (m: Meeting) => m.status === "complete" || m.status === "recovered";
const waiting = (s: TranscriptStatus) => s === "none" || s === "queued";
const JOB_KINDS = ["transcript", "summary"] as const;

/** The next job a meeting needs, if any. */
const nextKind = (m: Meeting): JobKind | null =>
  !saved(m) ? null : waiting(m.transcript) ? "transcript" : m.transcript === "done" && waiting(m.summary) ? "summary" : null;

export class TranscriptionService {
  private power: "ac" | "battery" | "unknown" = "unknown";
  /** Reserved synchronously in pump() (before any await), so two triggers can't start two jobs. */
  private running: Job | null = null;
  private readonly pending = new Map<string, JobKind>();
  /** `${kind}:${id}` the user asked for explicitly: they run even if the automatic setting is off. */
  private readonly manual = new Set<string>();
  private readonly failures = new Map<string, number>();
  private readonly blocked: Partial<Record<JobKind, Block>> = {};
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAt = 0;
  private readonly unsubscribe: () => void;
  private readonly d: TranscriptionDeps;
  private readonly now: () => number;

  constructor(deps: TranscriptionDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    if (!deps.transcriberPath) {
      const forever = Number.POSITIVE_INFINITY;
      this.blocked.transcript = { reason: "Transcription isn't installed.", until: forever };
      this.blocked.summary = { reason: "Summaries need transcription, which isn't installed.", until: forever };
    }
    this.unsubscribe = deps.bus.subscribe((event) => {
      if (event.type === "meeting") {
        const kind = nextKind(event.meeting);
        if (kind) this.pending.set(event.meeting.id, kind);
        else this.pending.delete(event.meeting.id);
      } else if (event.type === "meetingDeleted") {
        this.pending.delete(event.id);
        if (this.running?.id === event.id) this.cancelRunning();
      } else if (event.type !== "status") {
        return; // share progress: not ours
      } else if (event.status.state !== "idle") {
        this.cancelRunning(); // a recording is starting: don't compete with it
      } else {
        this.pump();
      }
    });
  }

  /** Boot: reset jobs interrupted by a crash or update, and build the pending map (one scan). */
  async init(): Promise<void> {
    for (let cursor: string | undefined; ;) {
      const page = this.d.repo.list(cursor, 500);
      for (const m of page.items) {
        let meeting = m;
        if (meeting.transcript === "running") meeting = await this.setStatus(meeting, "transcript", "queued");
        if (meeting.summary === "running") meeting = await this.setStatus(meeting, "summary", "queued");
        // Automatic jobs wait at "none"; "queued" means the user asked (or a retry is due), so it
        // must still run after a restart even if its automatic setting is off.
        if (meeting.transcript === "queued") this.manual.add(`transcript:${meeting.id}`);
        if (meeting.summary === "queued") this.manual.add(`summary:${meeting.id}`);
        const kind = nextKind(meeting);
        if (kind) this.pending.set(meeting.id, kind);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  }

  /** Why a kind of job can't run on this Mac right now (null when it can). */
  unavailableFor(kind: JobKind): string | null {
    const block = this.blocked[kind];
    return block && block.until > this.now() ? block.reason : null;
  }

  get unavailable(): string | null { return this.unavailableFor("transcript"); }

  /** Jobs run on battery too: they're at background priority (efficiency cores), and waiting for
   *  a charger made transcripts arrive hours late. The first power report just opens the gate. */
  setPower(state: "ac" | "battery"): void {
    this.power = state;
    this.pump();
  }

  /** Settings changed: stop a job its setting turned off; re-check unavailable kinds (the user
   *  may have just turned Apple Intelligence on); maybe start a job. */
  settingsChanged(): void {
    for (const kind of JOB_KINDS) {
      const block = this.blocked[kind];
      if (block && Number.isFinite(block.until)) delete this.blocked[kind];
    }
    if (this.running && !this.manual.has(`${this.running.kind}:${this.running.id}`) && !this.autoAllowed(this.running.kind)) this.cancelRunning();
    else this.pump();
  }

  /** "Transcribe now" / "Summarize now" / Retry from the dashboard. */
  async enqueue(id: string, kind: JobKind = "transcript"): Promise<Meeting> {
    const meeting = this.d.repo.get(id);
    if (!meeting) throw notFound("Meeting");
    if (!saved(meeting)) throw conflict(`Only saved recordings can be ${kind === "summary" ? "summarized" : "transcribed"}.`);
    if (kind === "summary" && meeting.transcript !== "done") throw conflict("A summary needs the transcript first.");
    const unavailable = this.unavailableFor(kind);
    if (unavailable) throw conflict(unavailable);
    const key = `${kind}:${id}`;
    this.failures.delete(key);
    this.manual.add(key);
    const queued = await this.setStatus(meeting, kind, "queued", null);
    this.pump();
    return queued;
  }

  /** True while a job using this open-model engine runs (it may be downloading the model itself). */
  isRunningEngine(engine: "whisper" | "qwen"): boolean {
    if (!this.running) return false;
    const t = this.d.settings().transcription;
    return (this.running.kind === "transcript" ? t.engine : t.summaryEngine) === engine;
  }

  /** Starts the next job if every gate is open. No disk scans. Safe to call at any time. */
  pump(): void {
    if (this.running || this.power === "unknown" || this.d.recording.stateName !== "idle") return;
    const t = this.d.settings().transcription;
    const engine = (kind: JobKind) => (kind === "transcript" ? t.engine : t.summaryEngine);
    const waitingForModel = (kind: JobKind) => { const e = engine(kind); return e !== "apple" && !!this.d.modelBusy?.(e); };
    const runnable = (id: string, kind: JobKind) =>
      !this.unavailableFor(kind) && !waitingForModel(kind) && (this.manual.has(`${kind}:${id}`) || this.autoAllowed(kind));
    // Common idle case first: nothing is allowed at all, so don't even look at the queue.
    if (!this.manual.size && !JOB_KINDS.some((k) => !this.unavailableFor(k) && this.autoAllowed(k))) return;

    const busy = this.d.recording.busyMeetingIds;
    let pick: { meeting: Meeting; kind: JobKind } | undefined;
    for (const id of [...this.pending.keys()].sort().reverse()) { // ids sort chronologically: newest first
      const kind = this.pending.get(id)!;
      if (busy.has(id) || !runnable(id, kind)) continue;
      const meeting = this.d.repo.get(id);
      if (!meeting || nextKind(meeting) !== kind) { this.pending.delete(id); continue; }
      pick = { meeting, kind };
      break;
    }
    if (!pick) return;
    const job: Job = { id: pick.meeting.id, kind: pick.kind, child: null, cancelled: false, timedOut: false, startedAt: 0 };
    this.running = job;
    void this.run(pick.meeting, job).catch((error: unknown) => {
      if (this.running === job) this.running = null;
      this.d.log.warn({ error }, "background job crashed");
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.cancelRunning();
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private autoAllowed(kind: JobKind): boolean {
    const t = this.d.settings().transcription;
    return t.enabled && (kind === "transcript" || t.summarize);
  }

  private async run(meeting: Meeting, job: Job): Promise<void> {
    const dir = this.d.repo.dir(meeting.id);
    // The old output stays until a new one replaces it (written atomically), so a failed redo
    // never loses a good transcript or summary. Only a file written after this point counts.
    job.startedAt = Date.now(); // compared with file times, so the real clock
    await this.setStatus(meeting, job.kind, "running", null);
    const args = jobArgs(job.kind, this.d.repo.recordingPath(meeting.id), dir, this.d.settings().transcription, this.d.modelsDir);
    const spawner = this.d.spawner ?? backgroundSpawn;
    const child = spawner(this.d.transcriberPath!, args);
    job.child = child;
    if (job.cancelled) child.kill("SIGTERM"); // cancelled while we were getting ready
    // The time limit starts again after a model download, which can take a while on first use.
    let watchdog: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { job.timedOut = true; child.kill("SIGKILL"); }, timeoutMs(meeting.durationSec));
    };
    arm();

    let lastError: string | null = null;
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const msg = JSON.parse(line) as { error?: string; status?: string };
          if (msg.error) lastError = msg.error;
          if (msg.status === "downloading") arm();
        } catch { /* ignore non-JSON output */ }
      });
    }
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (exitCode) => resolve(exitCode)); // after stdout is drained: the last error line counts
      child.on("error", () => resolve(null));
    });
    clearTimeout(watchdog);
    this.running = null;
    await this.finish(job, code, lastError);
    this.pump();
  }

  private async finish(job: Job, code: number | null, lastError: string | null): Promise<void> {
    const current = this.d.repo.get(job.id);
    if (!current) return; // deleted meanwhile
    const key = `${job.kind}:${job.id}`;
    const dir = this.d.repo.dir(job.id);

    if (job.cancelled) {
      await this.setStatus(current, job.kind, "queued");
      return;
    }
    if (code === 0 && (await this.writtenSince(join(dir, OUTPUT[job.kind]), job.startedAt))) {
      this.failures.delete(key);
      this.manual.delete(key);
      const done = await this.setStatus(current, job.kind, "done", null);
      // A new transcript makes an old summary wrong. A meeting that had a summary gets a new one
      // (even with automatic summaries off); otherwise it waits for the usual rules.
      if (job.kind === "transcript" && done.summary !== "none") {
        this.failures.delete(`summary:${job.id}`);
        if (done.summary === "done") this.manual.add(`summary:${job.id}`);
        await this.setStatus(done, "summary", done.summary === "done" ? "queued" : "none", null);
      }
      this.d.log.info({ id: job.id, kind: job.kind }, "job done");
      return;
    }
    if (code === 3) {
      this.blocked[job.kind] = { reason: lastError ?? "Not available on this Mac.", until: this.now() + UNAVAILABLE_RECHECK_MS };
      this.manual.delete(key);
      await this.setStatus(current, job.kind, "none", lastError);
      this.scheduleRetry(UNAVAILABLE_RECHECK_MS); // re-check then, without waiting for another event
      return;
    }
    if (code === 5) {
      this.blocked[job.kind] = { reason: lastError ?? "Not ready yet.", until: this.now() + NOT_READY_RETRY_MS };
      await this.setStatus(current, job.kind, "queued", lastError);
      this.scheduleRetry(NOT_READY_RETRY_MS);
      return;
    }
    const attempts = code === 6 ? MAX_ATTEMPTS : (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, attempts);
    const failed = attempts >= MAX_ATTEMPTS;
    if (failed) this.manual.delete(key);
    await this.setStatus(current, job.kind, failed ? "failed" : "queued", lastError ?? (job.timedOut ? "It took too long and was stopped." : null));
    this.d.log.warn({ id: job.id, kind: job.kind, code, attempts, timedOut: job.timedOut, error: lastError }, "job failed");
  }

  /** One timer; the sooner of two requested retries wins. */
  private scheduleRetry(ms: number): void {
    const at = this.now() + ms;
    if (this.retryTimer && this.retryAt <= at) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryAt = at;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.pump(); }, ms);
    this.retryTimer.unref?.();
  }

  private cancelRunning(): void {
    if (!this.running) return;
    this.running.cancelled = true;
    this.running.child?.kill("SIGTERM");
  }

  /** Saves a job status (and optionally its error message) and tells the dashboard. */
  private async setStatus(meeting: Meeting, kind: JobKind, status: TranscriptStatus, error?: string | null): Promise<Meeting> {
    const next: Meeting = { ...meeting, [kind]: status };
    if (error !== undefined) next[ERROR_FIELD[kind]] = error;
    await this.d.repo.save(next);
    this.d.bus.publish({ type: "meeting", meeting: next }); // also keeps `pending` in sync
    return next;
  }

  private async writtenSince(path: string, since: number): Promise<boolean> {
    try { return (await stat(path)).mtimeMs >= since - 1000; } catch { return false; } // 1 s: coarse file times
  }
}
