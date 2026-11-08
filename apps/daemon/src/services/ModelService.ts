// Open models (Whisper, Qwen): are they downloaded, and download them on request with progress.
//
//   GET  /api/models                 { whisper: ModelState, qwen: ModelState }
//   POST /api/models/:engine/cancel   stops it (verified files are kept, so the next download resumes)
//   POST /api/models/:engine/download ─▶ MeetingRecorderTranscriber --prepare <engine> --models <dir>
//        {"status":"downloading","percent":n,"what":…} lines ─▶ {type:"model"} SSE events ─▶ progress bar
//
// Status comes from `--model-status` (file checks only: no hashing, no network). One download at a
// time per engine. Downloads run at utility priority: the user is waiting, but it still mustn't
// slow the Mac down. Jobs that need a model wait while it downloads (TranscriptionService.pump).
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import type { ModelEngine, ModelState } from "@meeting-recorder/shared";
import { conflict } from "../lib/errors.ts";
import type { Logger } from "../repositories/MeetingRepository.ts";
import type { EventBus } from "./EventBus.ts";
import { policySpawn, type Spawner } from "./TranscriptionService.ts";

export interface ModelDeps {
  bus: EventBus;
  log: Logger;
  transcriberPath: string | null;
  modelsDir: string;
  /** Why an engine can't run on this Mac (null when it can, or when it isn't known yet). */
  unavailable: (engine: ModelEngine) => Promise<string | null>;
  /** True while a meeting job using this engine runs: it downloads the model itself. */
  jobUsing: (engine: ModelEngine) => boolean;
  spawner?: Spawner;
  /** --model-status runner (injectable for tests). */
  status?: () => Promise<Record<ModelEngine, boolean> | null>;
}

const ENGINES: ModelEngine[] = ["whisper", "qwen"];

/** Utility priority (the user is watching), own process group (kill stops the whole download). */
const utilitySpawn = policySpawn(["-c", "utility"]);

export class ModelService {
  private readonly d: ModelDeps;
  private readonly states = new Map<ModelEngine, ModelState>();
  private readonly running = new Map<ModelEngine, () => void>();
  private readonly cancelled = new Set<ModelEngine>();
  private readonly held = new Set<ModelEngine>();
  /** Called when a download finishes (either way), so jobs that waited for it can go on. */
  onFinished: () => void = () => {};

  constructor(deps: ModelDeps) {
    this.d = deps;
  }

  isDownloading(engine: ModelEngine): boolean {
    return this.running.has(engine);
  }

  /** Jobs needing this model must wait: it's downloading, or the user cancelled its download (a
   *  job would otherwise download it anyway, undoing the cancel). Download now lifts the hold. */
  holdsJobs(engine: ModelEngine): boolean {
    return this.running.has(engine) || this.held.has(engine);
  }

  /** Current state of both engines. Unknown ones are checked on disk first. */
  async get(): Promise<Record<ModelEngine, ModelState>> {
    const live = ENGINES.filter((e) => !this.running.has(e));
    if (live.length) {
      const installed = await (this.d.status ?? (() => this.modelStatus()))();
      for (const engine of live) {
        if (this.running.has(engine)) continue; // a download started while we were checking: keep its state
        const reason = await this.d.unavailable(engine);
        const previous = this.states.get(engine);
        if (reason) this.states.set(engine, { state: "unavailable", error: reason });
        else if (installed?.[engine]) this.states.set(engine, { state: "ready" });
        else if (previous?.state !== "failed") this.states.set(engine, { state: "missing" });
      }
    }
    return { whisper: this.states.get("whisper")!, qwen: this.states.get("qwen")! };
  }

  /** Starts a download (no-op if one is running). Resolves with the state right after starting. */
  async download(engine: ModelEngine): Promise<ModelState> {
    if (!this.d.transcriberPath) throw conflict("Open models need the transcription helper, which isn't installed.");
    if (this.running.has(engine)) return this.states.get(engine)!;
    if (this.d.jobUsing(engine)) throw conflict("A meeting is being processed with this model right now and is downloading it. Try again in a moment.");
    this.held.delete(engine);
    this.cancelled.delete(engine);
    // Reserve before any await, so two clicks (or two windows) can't start two downloads.
    let kill = () => {};
    this.running.set(engine, () => kill());
    const previous = this.states.get(engine);
    this.states.set(engine, { state: "downloading", percent: 0 });
    let current: ModelState;
    try {
      current = (await this.check(engine)) ?? { state: "missing" };
    } catch (error) {
      this.running.delete(engine);
      if (previous) this.states.set(engine, previous); else this.states.delete(engine);
      throw error;
    }
    if (this.cancelled.delete(engine)) { // cancelled while we were checking: never start it
      this.running.delete(engine);
      this.held.add(engine);
      this.states.set(engine, { state: "missing" });
      this.d.bus.publish({ type: "model", engine, state: "missing" });
      return { state: "missing" };
    }
    if (current.state === "unavailable" || current.state === "ready") {
      this.running.delete(engine);
      this.states.set(engine, current);
      if (current.state === "unavailable") throw conflict(current.error ?? "This Mac can't run that model.");
      return current;
    }

    const child = (this.d.spawner ?? utilitySpawn)(this.d.transcriberPath, ["--prepare", engine, "--models", this.d.modelsDir]);
    kill = () => { child.kill("SIGTERM"); };
    const publish = (state: ModelState) => {
      this.states.set(engine, state);
      this.d.bus.publish({ type: "model", engine, ...state });
    };
    publish({ state: "downloading", percent: 0 });

    let lastError: string | undefined;
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const msg = JSON.parse(line) as { status?: string; percent?: number; what?: string; error?: string };
          if (msg.status === "downloading" && typeof msg.percent === "number") {
            publish({ state: "downloading", percent: Math.max(0, Math.min(100, msg.percent)), ...(msg.what ? { what: msg.what } : {}) });
          }
          if (msg.error) lastError = msg.error;
        } catch { /* non-JSON line */ }
      });
    }
    let finished = false;
    const done = (code: number | null) => {
      if (finished) return;
      finished = true;
      this.running.delete(engine);
      const cancelled = this.cancelled.delete(engine);
      if (code === 0) publish({ state: "ready" }); // finished just as Cancel arrived: it's installed
      else if (cancelled) publish({ state: "missing" });
      else {
        this.d.log.warn({ engine, code, error: lastError }, "model download failed");
        publish({ state: "failed", error: lastError ?? "The download didn't finish. Try again." });
      }
      this.onFinished();
    };
    child.on("close", done); // after stdout is drained: the last error line counts
    child.on("error", () => done(null));
    return this.states.get(engine)!;
  }

  /** Stops a running download (or one still being set up). Files already verified are kept, so
   *  the next download resumes. Meetings needing the model wait until it's downloaded. Returns
   *  the state the cancel leads to. */
  cancel(engine: ModelEngine): ModelState {
    const kill = this.running.get(engine);
    if (!kill) return this.states.get(engine) ?? { state: "missing" };
    this.cancelled.add(engine);
    this.held.add(engine);
    kill(); // a no-op before the process exists: download() sees `cancelled` after its check
    return { state: "missing" };
  }

  dispose(): void {
    for (const kill of this.running.values()) kill();
  }

  /** One engine's state on disk (ready / unavailable), or null for "not downloaded". */
  private async check(engine: ModelEngine): Promise<ModelState | null> {
    const reason = await this.d.unavailable(engine);
    if (reason) return { state: "unavailable", error: reason };
    const installed = await (this.d.status ?? (() => this.modelStatus()))();
    return installed?.[engine] ? { state: "ready" } : null;
  }

  private modelStatus(): Promise<Record<ModelEngine, boolean> | null> {
    if (!this.d.transcriberPath) return Promise.resolve(null);
    return new Promise((resolve) => {
      execFile(this.d.transcriberPath!, ["--model-status", "--models", this.d.modelsDir], { timeout: 10_000 }, (error, stdout) => {
        try {
          const raw = JSON.parse(stdout) as Record<string, unknown>;
          resolve(error ? null : { whisper: raw.whisper === true, qwen: raw.qwen === true });
        } catch {
          resolve(null);
        }
      });
    });
  }
}
