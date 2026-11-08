// HTTP API shapes shared by the daemon (Fastify) and the dashboard (React).

export type MeetingStatus = "recording" | "complete" | "recovered" | "failed";
/** Status of a background job on a meeting (transcript, summary). */
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
  /** On-device summary, made after the transcript. */
  summary: TranscriptStatus;
  /** Why the last transcript / summary attempt failed, when it did. */
  transcriptError?: string | null;
  summaryError?: string | null;
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
  quality: "720p30" | "1080p30" | "720p15" | "1080p15" | "720p10";
  /** On-device transcription and, after it, an on-device summary. `language` is "auto" (this
   *  Mac's language) or a language id such as "en_IN" or "hi_IN". */
  transcription: { enabled: boolean; summarize: boolean; language: string };
  /** Extra bundle IDs that should trigger auto-recording when they use the mic. */
  extraApps: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  autoRecord: true,
  quality: "720p30",
  transcription: { enabled: true, summarize: true, language: "auto" },
  extraApps: [],
};

/** transcript.json written by the on-device transcriber (one timeline, speaker per track). */
export interface Transcript {
  version: 1;
  language: string;
  durationSec: number;
  segments: { start: number; end: number; speaker: string; text: string }[];
}

/** What the transcription features can do on this Mac (GET /api/jobs). */
export interface JobsInfo {
  transcriptUnavailable: string | null;
  summaryUnavailable: string | null;
  /** Languages the on-device transcriber supports, e.g. ["en_IN", "hi_IN", …]. */
  languages: string[];
}

/** summary.json written by the on-device summarizer. */
export interface MeetingSummary {
  version: 1;
  overview: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: string[];
}

/** Server-Sent Events pushed to the dashboard on /api/events. */
export type ServerEvent =
  | { type: "status"; status: Status }
  | { type: "meeting"; meeting: Meeting }
  | { type: "meetingDeleted"; id: string };
