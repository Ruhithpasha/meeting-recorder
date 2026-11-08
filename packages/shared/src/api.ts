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
   *  Mac's language, or detected by Whisper) or a language id such as "en_IN" or "hi_IN".
   *  Engines: Apple's built-in models, or open models downloaded once from Hugging Face. */
  transcription: { enabled: boolean; summarize: boolean; language: string; engine: TranscriptEngine; summaryEngine: SummaryEngine };
  /** Extra bundle IDs that should trigger auto-recording when they use the mic. */
  extraApps: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  autoRecord: false, // ask: a detected meeting shows a Record button; nothing records until pressed
  quality: "720p30",
  transcription: { enabled: true, summarize: true, language: "auto", engine: "apple", summaryEngine: "apple" },
  extraApps: [],
};

/** transcript.json written by the on-device transcriber (one timeline, speaker per track). */
export interface Transcript {
  version: 1;
  language: string;
  durationSec: number;
  segments: { start: number; end: number; speaker: string; text: string }[];
}

export type TranscriptEngine = "apple" | "whisper";
export type SummaryEngine = "apple" | "qwen";

/** What the transcription features can do on this Mac (GET /api/jobs). */
export interface JobsInfo {
  transcriptUnavailable: string | null;
  summaryUnavailable: string | null;
  /** Languages the on-device transcriber supports, e.g. ["en_IN", "hi_IN", …]. */
  languages: string[];
  /** Languages the Whisper engine supports, as codes ("hi", "en", …); works on any macOS. */
  whisperLanguages: string[];
  /** Why an open-model engine can't run on this Mac (null when it can). */
  engines: { whisper: string | null; qwen: string | null };
}

/** An open model on this Mac (GET /api/models, {type:"model"} events). */
export type ModelEngine = "whisper" | "qwen";
export interface ModelState {
  state: "missing" | "downloading" | "ready" | "failed" | "unavailable";
  /** 0-100 while downloading. */
  percent?: number;
  /** What's happening now, e.g. "Whisper model" or "Preparing Whisper for this Mac". */
  what?: string;
  error?: string;
}

/** Share a meeting through the macOS share sheet (POST /api/meetings/:id/share). */
export type ShareWhat = "video" | "original" | "summary";

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
  | { type: "meetingDeleted"; id: string }
  /** Progress of a share copy (POST /api/meetings/:id/share with what "video"). */
  | ({ type: "model"; engine: ModelEngine } & ModelState)
  /** One finished line of the live transcript of the meeting being recorded. */
  | { type: "liveTranscript"; id: string; segment: Transcript["segments"][number] }
  | { type: "share"; id: string; state: "exporting" | "ready" | "failed"; percent?: number; error?: string };
