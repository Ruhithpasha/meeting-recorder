// Decides when a meeting starts and ends, from the agent's mic events.
//
//   mic event ──▶ match rules ──┬─ match held 3 s ─▶ automatic recording on:  start
//                               │                    off (default): ask (a "Record" prompt; nothing
//                               │                    records until the user presses it)
//                               └─ no match held 15 s ─────────▶ stop (recordings started by
//                                                                  detection or from the prompt)
//
// Hysteresis: a start/stop timer is cancelled if the signal flips back before it fires, so a muted
// mic for a few seconds or a brief window switch never splits a meeting.
//
// Respecting the user: if the recorder goes idle while the meeting is still on (the user pressed
// Stop, or the start failed), auto-start is suppressed until the meeting ends, so we never restart
// a recording the user just stopped, or retry a failing start every 3 seconds.
//
// Except when the recorder itself failed mid-meeting: the rest of the call must not be lost, so a
// new recording ("… (continued)") starts right away, at most MAX_CONTINUATIONS times per meeting.
import type { MicEvent, Settings } from "@meeting-recorder/shared";
import { continuedTitle } from "../models/meeting.ts";
import type { Logger } from "../repositories/MeetingRepository.ts";
import type { EventBus } from "./EventBus.ts";
import rulesFile from "./detection-rules.json" with { type: "json" };
import type { RecordingService } from "./RecordingService.ts";

export const START_AFTER_MS = 3_000;
export const STOP_AFTER_MS = 15_000;
export const OWN_BUNDLE_ID = "com.meetingrecorder.agent";
export const MAX_CONTINUATIONS = 3;
export const CONTINUE_AFTER_MS = 1_000;

export interface DetectionRule {
  label: string;
  micBundleIds: string[];
  windowBundleIds?: string[];
  titles?: { pattern: string; label: string }[];
}

export interface Match { app: string; title: string }

interface CompiledRule extends DetectionRule { compiled?: { regex: RegExp; label: string }[] }

/** Title patterns are compiled once, not on every mic event. */
export const compileRules = (rules: DetectionRule[]): CompiledRule[] =>
  rules.map((r) => ({ ...r, compiled: r.titles?.map((t) => ({ regex: new RegExp(t.pattern, "i"), label: t.label })) }));

const bundleMatches = (patterns: string[], bundleId: string) =>
  patterns.some((p) => (p.endsWith("*") ? bundleId.startsWith(p.slice(0, -1)) : bundleId === p));

/** Pure matcher: which meeting (if any) does this mic event describe? */
export function matchMeeting(event: MicEvent, rules: CompiledRule[], extraApps: string[]): Match | null {
  const users = event.users.filter((u) => u.bundleId !== OWN_BUNDLE_ID);
  const allRules: CompiledRule[] = [...rules, ...extraApps.map((id) => ({ label: id, micBundleIds: [id] }))];
  for (const user of users) {
    for (const rule of allRules) {
      if (!bundleMatches(rule.micBundleIds, user.bundleId)) continue;
      if (!rule.compiled) return { app: rule.label, title: rule.label };
      for (const window of event.windows) {
        if (!bundleMatches(rule.windowBundleIds ?? rule.micBundleIds, window.bundleId)) continue;
        const title = rule.compiled.find((t) => t.regex.test(window.title));
        if (title) return { app: title.label, title: window.title };
      }
    }
  }
  return null;
}

/** Sends the Record prompt to the agent (label shows it, none hides it). */
export type Prompt = (label: string | null) => void;

export class DetectionService {
  private enabled = true;
  private matching = false;      // last mic event matched a meeting
  private suppressed = false;    // recorder went idle mid-meeting: wait for the meeting to end
  private wasActive = false;
  private continuations = 0;     // recordings restarted after a recorder failure, this meeting
  private suggested: Match | null = null; // the meeting the Record prompt is showing for
  private readonly prompt: Prompt;
  private startTimer: NodeJS.Timeout | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private readonly rules: CompiledRule[];
  private readonly unsubscribe: () => void;
  private readonly recording: RecordingService;
  private readonly settings: () => Settings;
  private readonly log: Logger;

  constructor(opts: { recording: RecordingService; settings: () => Settings; log: Logger; bus: EventBus; rules?: DetectionRule[]; prompt?: Prompt }) {
    this.recording = opts.recording;
    this.prompt = opts.prompt ?? (() => {});
    this.settings = opts.settings;
    this.log = opts.log;
    this.rules = compileRules(opts.rules ?? (rulesFile.rules as DetectionRule[]));
    this.unsubscribe = opts.bus.subscribe((event) => {
      if (event.type !== "status") return;
      const active = event.status.state !== "idle";
      if (active) this.hidePrompt(); // recording now: the prompt has done its job
      if (this.wasActive && !active && this.matching) {
        const crashed = this.recording.crashedAutoMeeting;
        if (crashed && this.enabled && this.continuations < MAX_CONTINUATIONS) this.continueAfterCrash(crashed);
        else this.suppressed = true;
      }
      this.wasActive = active;
    });
  }

  /** The Record button on the prompt: record the suggested meeting (stops itself when the meeting
   *  ends, like an automatic recording). False if there's nothing to record. */
  recordSuggested(): boolean {
    const match = this.suggested;
    if (!match || !this.enabled || this.recording.stateName !== "idle") return false;
    this.hidePrompt();
    this.log.info(match, "recording the detected meeting (from the prompt)");
    void this.recording.dispatch({ type: "start", trigger: { ...match, source: "auto" } });
    return true;
  }

  private hidePrompt(): void {
    if (!this.suggested) return;
    this.suggested = null;
    this.prompt(null);
  }

  /** Disabled on protocol mismatch: never auto-record with an agent we can't trust to understand us. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) { this.clearStart(); this.hidePrompt(); }
  }

  onMic(event: MicEvent): void {
    const match = this.enabled ? matchMeeting(event, this.rules, this.settings().extraApps) : null;
    this.matching = match !== null;

    if (match) {
      this.clearStop();
      if (this.recording.stateName === "idle" && !this.startTimer && !this.suppressed && !this.suggested) {
        this.startTimer = setTimeout(() => {
          this.startTimer = null;
          if (this.recording.stateName !== "idle") return;
          if (this.settings().autoRecord) {
            this.log.info(match, "meeting detected, starting recording");
            void this.recording.dispatch({ type: "start", trigger: { ...match, source: "auto" } });
          } else {
            this.log.info(match, "meeting detected, asking whether to record");
            this.suggested = match;
            this.prompt(match.app);
          }
        }, START_AFTER_MS);
      }
      return;
    }

    this.clearStart();
    this.hidePrompt(); // the meeting is over
    this.suppressed = false; // the meeting is over: the next one may auto-record again
    this.continuations = 0;
    const active = this.recording.stateName === "starting" || this.recording.stateName === "recording";
    if (active && this.recording.isAutoStarted && !this.stopTimer) {
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        // Re-check at fire time: the user may have started a manual recording in the meantime.
        if (!this.recording.isAutoStarted) return;
        this.log.info({}, "meeting ended, stopping recording");
        void this.recording.dispatch({ type: "stop", reason: "meeting-ended" });
      }, STOP_AFTER_MS);
    }
  }

  private continueAfterCrash(crashed: { app: string; title: string }): void {
    this.continuations += 1;
    this.clearStart();
    const title = continuedTitle(crashed.title);
    this.log.warn({ app: crashed.app, attempt: this.continuations }, "recorder failed mid-meeting; continuing in a new recording");
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.recording.stateName !== "idle" || !this.matching) return;
      void this.recording.dispatch({ type: "start", trigger: { app: crashed.app, title, source: "auto" } });
    }, CONTINUE_AFTER_MS);
  }

  dispose(): void {
    this.unsubscribe();
    this.clearStart();
    this.clearStop();
  }

  private clearStart(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private clearStop(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }
}
