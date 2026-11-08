// Recording state machine. The ONLY place recorder state changes.
//
//            start(trigger)                 agentStarted
//  ┌──────┐ ───────────────▶ ┌──────────┐ ──────────────▶ ┌───────────┐
//  │ idle │                  │ starting │                 │ recording │◀── adopt (hello with
//  └──────┘ ◀─────────────── └──────────┘                 └───────────┘     activeMeetingId)
//     ▲      agentError / 10 s timeout:     │ stop while starting:      │ stop(reason)
//     │      delete empty folder, warn      │ remembered, applied once  ▼
//     │                                     │ recording is confirmed ┌──────────┐
//     │                                                            │ stopping │
//     └─────────────────────────────────────────────────────────── └──────────┘
//        agentStopped: write meta.json (complete), remove state file
//        agentError while recording/stopping: recover the file (the agent closes its writer first)
//        20 s stop timeout: go idle WITHOUT touching the file (the agent may still be writing);
//          the meeting is "detached" and finalized when its late agentStopped/agentError arrives,
//          or by RecoveryService on the next start.
//
// File I/O failures never strand the machine: every terminal transition reaches idle (finally).
//
// Events are processed one at a time (serial promise queue), so async side effects (files, agent
// commands) of one transition never interleave with another. Events that don't apply to the
// current state, or carry another meeting's id, are logged and ignored.
import type { AgentErrorCode, Meeting, Settings, StartCommand } from "@meeting-recorder/shared";
import type { AgentPort } from "../agent/AgentChannel.ts";
import { meetingId, newMeeting } from "../models/meeting.ts";
import type { Logger, MeetingRepository } from "../repositories/MeetingRepository.ts";
import type { EventBus } from "./EventBus.ts";
import type { RecoveryService } from "./RecoveryService.ts";
import type { StatusService } from "./StatusService.ts";

export const START_TIMEOUT_MS = 10_000;
export const STOP_TIMEOUT_MS = 20_000;

export interface Trigger { app: string; title: string; source: "auto" | "manual" }
export type StopReason = "manual" | "meeting-ended" | "sleep" | "disk" | "quit";

export type RecordingEvent =
  | { type: "start"; trigger: Trigger }
  | { type: "stop"; reason: StopReason }
  | { type: "adopt"; meetingId: string }
  | { type: "agentStarted"; meetingId: string }
  | { type: "agentStopped"; meetingId: string; durationSec: number }
  | { type: "agentError"; meetingId: string; code: AgentErrorCode; message: string }
  | { type: "startTimeout"; meetingId: string }
  | { type: "stopTimeout"; meetingId: string };

type State =
  | { name: "idle" }
  | { name: "starting"; meeting: Meeting; auto: boolean; pendingStop: boolean }
  | { name: "recording"; meeting: Meeting; auto: boolean }
  | { name: "stopping"; meeting: Meeting; auto: boolean };

const QUALITY: Record<Settings["quality"], Pick<StartCommand, "height" | "fps">> = {
  "720p15": { height: 720, fps: 15 },
  "1080p15": { height: 1080, fps: 15 },
  "720p10": { height: 720, fps: 10 },
};

export interface RecordingDeps {
  repo: MeetingRepository;
  agent: AgentPort;
  status: StatusService;
  bus: EventBus;
  recovery: RecoveryService;
  settings: () => Settings;
  hasDiskSpace: () => Promise<boolean>;
  log: Logger;
}

export class RecordingService {
  private state: State = { name: "idle" };
  private timer: NodeJS.Timeout | null = null;
  /** Meetings whose stop timed out: the agent may still be finishing them. */
  private readonly detached = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly d: RecordingDeps;

  constructor(deps: RecordingDeps) {
    this.d = deps;
  }

  get stateName(): State["name"] { return this.state.name; }
  get currentMeetingId(): string | null { return this.state.name === "idle" ? null : this.state.meeting.id; }
  /** True when the current recording was started by detection (so detection may also stop it). */
  get isAutoStarted(): boolean { return this.state.name !== "idle" && this.state.auto; }
  /** Meetings that must not be recovered or deleted: the current one and any detached ones. */
  get busyMeetingIds(): Set<string> {
    const ids = new Set(this.detached);
    if (this.state.name !== "idle") ids.add(this.state.meeting.id);
    return ids;
  }

  /** Queues an event. Resolves once it (and everything before it) has been fully handled. */
  dispatch(event: RecordingEvent): Promise<void> {
    this.queue = this.queue
      .then(() => this.transition(event))
      .catch((error: unknown) => this.d.log.warn({ error, event }, "recording transition failed"));
    return this.queue;
  }

  /** Resolves once every event queued so far has been handled. */
  settled(): Promise<void> {
    return this.queue;
  }

  /** Menu-bar / dashboard toggle: start a manual recording when idle, otherwise stop. */
  toggle(): Promise<void> {
    return this.state.name === "idle"
      ? this.dispatch({ type: "start", trigger: { app: "Manual", title: "Manual recording", source: "manual" } })
      : this.dispatch({ type: "stop", reason: "manual" });
  }

  private async transition(event: RecordingEvent): Promise<void> {
    // A detached meeting's late result is handled in ANY state, without disturbing the current one.
    if ((event.type === "agentStopped" || event.type === "agentError") && this.detached.has(event.meetingId)) {
      return this.finalizeDetached(event);
    }
    const s = this.state;
    switch (s.name) {
      case "idle":
        if (event.type === "start") return this.begin(event.trigger);
        if (event.type === "adopt") return this.adopt(event.meetingId);
        break;

      case "starting":
        if (!this.isFor(event, s.meeting.id)) break;
        if (event.type === "agentStarted") {
          this.clearTimer();
          this.set({ name: "recording", meeting: s.meeting, auto: s.auto });
          if (s.pendingStop) return this.requestStop();
          return;
        }
        if (event.type === "stop") { s.pendingStop = true; return; }
        if (event.type === "agentError") return this.abortStart(s.meeting, event.message);
        if (event.type === "startTimeout") {
          this.d.agent.send({ cmd: "stop", meetingId: s.meeting.id }); // in case it starts late
          return this.abortStart(s.meeting, "Recording didn't start within 10 seconds.");
        }
        break;

      case "recording":
      case "stopping":
        if (!this.isFor(event, s.meeting.id)) break;
        if (event.type === "stop" && s.name === "recording") return this.requestStop();
        if (event.type === "agentStopped") return this.finish(s.meeting, event.durationSec);
        if (event.type === "agentError") return this.recoverAndIdle(s.meeting, event.message);
        if (event.type === "stopTimeout" && s.name === "stopping") {
          this.detached.add(s.meeting.id);
          this.d.status.setWarning("recording", "The recorder is taking long to save the last recording. It will be finished when it's done.");
          this.set({ name: "idle" });
          return;
        }
        break;
    }
    this.d.log.info({ state: s.name, event: event.type }, "recording event ignored");
  }

  /** Events that carry a meeting id must match the current meeting. */
  private isFor(event: RecordingEvent, id: string): boolean {
    return !("meetingId" in event) || event.meetingId === id;
  }

  private async begin(trigger: Trigger): Promise<void> {
    if (!(await this.d.hasDiskSpace())) {
      this.d.status.setWarning("disk", "Not recording: less than 2 GB of disk space left.");
      return;
    }
    const now = new Date();
    let meeting: Meeting | null = null;
    for (let attempt = 0; attempt < 5 && !meeting; attempt++) {
      const candidate = newMeeting(meetingId(now, trigger.app, attempt || undefined), trigger.app, trigger.title, now);
      if (await this.d.repo.create(candidate)) meeting = candidate;
    }
    if (!meeting) throw new Error("could not create a unique meeting folder");

    this.d.status.setWarning("recording", null);
    this.set({ name: "starting", meeting, auto: trigger.source === "auto", pendingStop: false });
    this.d.bus.publish({ type: "meeting", meeting });
    this.d.agent.send({ cmd: "start", meetingId: meeting.id, path: this.d.repo.recordingPath(meeting.id), ...QUALITY[this.d.settings().quality] });
    this.armTimer({ type: "startTimeout", meetingId: meeting.id }, START_TIMEOUT_MS);
  }

  /** Daemon restarted while the agent kept recording: take over the in-progress meeting. */
  private async adopt(id: string): Promise<void> {
    const meeting = this.d.repo.get(id);
    if (!meeting) {
      this.d.log.warn({ id }, "agent reports an active meeting the daemon doesn't know");
      return;
    }
    this.set({ name: "recording", meeting, auto: meeting.app !== "Manual" });
  }

  private requestStop(): void {
    const s = this.state;
    if (s.name !== "recording") return;
    this.set({ name: "stopping", meeting: s.meeting, auto: s.auto });
    this.d.agent.send({ cmd: "stop", meetingId: s.meeting.id });
    this.armTimer({ type: "stopTimeout", meetingId: s.meeting.id }, STOP_TIMEOUT_MS);
  }

  private async finalizeDetached(event: Extract<RecordingEvent, { type: "agentStopped" | "agentError" }>): Promise<void> {
    this.detached.delete(event.meetingId);
    const meeting = this.d.repo.get(event.meetingId);
    if (!meeting) return;
    try {
      if (event.type === "agentStopped") await this.saveComplete(meeting, event.durationSec);
      else await this.recoverFile(meeting.id);
    } catch (error) {
      this.d.log.warn({ error, id: meeting.id }, "finalizing a detached meeting failed; recovery will retry");
    }
  }

  private async abortStart(meeting: Meeting, message: string): Promise<void> {
    await this.toIdleAfter(async () => {
      await this.d.repo.deleteFolder(meeting.id);
      this.d.bus.publish({ type: "meetingDeleted", id: meeting.id });
    }, message);
  }

  private async finish(meeting: Meeting, durationSec: number): Promise<void> {
    await this.toIdleAfter(() => this.saveComplete(meeting, durationSec));
  }

  private async recoverAndIdle(meeting: Meeting, message: string): Promise<void> {
    await this.toIdleAfter(() => this.recoverFile(meeting.id), message);
  }

  private async saveComplete(meeting: Meeting, durationSec: number): Promise<void> {
    const sizeBytes = await this.d.repo.recordingSize(meeting.id);
    if (durationSec === 0 && !sizeBytes) {
      // The agent reports 0 s only when capture never produced a frame (Start then Stop at once):
      // nothing was recorded, so there is no meeting. Any other case keeps the folder.
      await this.d.repo.deleteFolder(meeting.id);
      this.d.bus.publish({ type: "meetingDeleted", id: meeting.id });
      return;
    }
    const done: Meeting = {
      ...meeting,
      status: "complete",
      endedAt: new Date().toISOString(),
      durationSec,
      sizeBytes,
    };
    await this.d.repo.save(done);
    await this.d.repo.removeState(meeting.id);
    this.d.bus.publish({ type: "meeting", meeting: done });
  }

  /** Recovers the file; if there was nothing recorded the folder is gone, so tell the dashboard. */
  private async recoverFile(id: string): Promise<void> {
    const recovered = await this.d.recovery.recoverOne(id);
    this.d.bus.publish(recovered ? { type: "meeting", meeting: recovered } : { type: "meetingDeleted", id });
  }

  /**
   * Runs a terminal transition's file work, then ALWAYS returns to idle. If the work fails (disk
   * full, EACCES), the state file stays behind for RecoveryService and the user gets a warning,
   * instead of the machine being stuck in starting/stopping forever.
   */
  private async toIdleAfter(work: () => Promise<void>, message?: string): Promise<void> {
    this.clearTimer();
    try {
      await work();
      if (message) this.d.status.setWarning("recording", message);
    } catch (error) {
      this.d.log.warn({ error }, "finishing a recording failed; it will be recovered on next start");
      this.d.status.setWarning("recording", "Couldn't finish saving the last recording. It will be recovered automatically.");
    } finally {
      this.set({ name: "idle" });
    }
  }

  private set(next: State): void {
    this.state = next;
    if (next.name === "idle") this.d.status.setRecorder("idle", null, null);
    else this.d.status.setRecorder(next.name, next.meeting.id, next.meeting.app);
  }

  private armTimer(event: RecordingEvent, ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.dispatch(event); }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
