// HTTP API shapes shared by the daemon (Fastify) and the dashboard (React).

export type MeetingStatus = "recording" | "complete" | "recovered" | "failed";
export type TranscriptStatus = "none" | "queued" | "running" | "done" | "failed";

/** Contents of <meeting folder>/meta.json, and what the API returns for a meeting. */
export interface Meeting {
  id: string;            // folder name, e.g. "2026-11-08_14-30-05_zoom"
  app: string;           // rule label, e.g. "Zoom", "Google Meet", "Manual"
  title: string;         // sanitized window title or app label
  startedAt: string;     // ISO 8601
  endedAt: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  status: MeetingStatus;
  transcript: TranscriptStatus;
}

export interface MeetingPage {
  items: Meeting[];
  nextCursor: string | null;
}

export type RecorderState = "idle" | "starting" | "recording" | "stopping";

export interface Status {
  state: RecorderState;
  meetingId: string | null;
  agentConnected: boolean;
  warning: string | null;  // e.g. version mismatch, screen permission lapsed
}

export interface Settings {
  autoRecord: boolean;
  quality: "720p15" | "1080p15" | "720p10";
  transcription: { enabled: boolean; model: "tiny" | "base" | "small" };
  /** Extra bundle IDs that should trigger auto-recording when they use the mic. */
  extraApps: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  autoRecord: true,
  quality: "720p15",
  transcription: { enabled: true, model: "base" },
  extraApps: [],
};

/** transcript.json written by the on-device transcriber (one timeline, speaker per track). */
export interface Transcript {
  version: 1;
  language: string;
  durationSec: number;
  segments: { start: number; end: number; speaker: string; text: string }[];
}

/** Server-Sent Events pushed to the dashboard on /api/events. */
export type ServerEvent =
  | { type: "status"; status: Status }
  | { type: "meeting"; meeting: Meeting }
  | { type: "meetingDeleted"; id: string };
