import { MEETING_ID_PATTERN, type Meeting } from "@meeting-recorder/shared";

export { MEETING_ID_PATTERN };

/** Lowercase, dash-separated, 1-40 chars of [a-z0-9-]; matches the slug part of MEETING_ID_PATTERN. */
export function slugify(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // drop combining accents: "Ü" -> "U"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "meeting";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Folder name sorts chronologically: "2026-11-08_14-30-05_zoom" (local time). */
export function meetingId(at: Date, label: string, suffix?: number): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  const slug = suffix ? `${slugify(label).slice(0, 37)}-${suffix}` : slugify(label);
  return `${date}_${time}_${slug}`;
}

/** Window titles come from other apps: strip control characters and cap the length. */
export function sanitizeTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 120) || "Meeting";
}

export function newMeeting(id: string, app: string, title: string, startedAt: Date): Meeting {
  return {
    id,
    app,
    title: sanitizeTitle(title),
    startedAt: startedAt.toISOString(),
    endedAt: null,
    durationSec: null,
    sizeBytes: null,
    status: "recording",
    transcript: "none",
    summary: "none",
    transcriptError: null,
    summaryError: null,
  };
}

/** Narrow, defensive parse of a meta.json read from disk (users can edit these files). */
export function parseMeeting(raw: unknown, expectedId: string): Meeting | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const statuses = ["recording", "complete", "recovered", "failed"];
  const transcripts = ["none", "queued", "running", "done", "failed"];
  if (m.id !== expectedId || typeof m.app !== "string" || typeof m.title !== "string") return null;
  if (typeof m.startedAt !== "string" || Number.isNaN(Date.parse(m.startedAt))) return null;
  if (typeof m.status !== "string" || !statuses.includes(m.status)) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    id: expectedId,
    app: m.app,
    title: m.title,
    startedAt: m.startedAt,
    endedAt: typeof m.endedAt === "string" ? m.endedAt : null,
    durationSec: num(m.durationSec),
    sizeBytes: num(m.sizeBytes),
    status: m.status as Meeting["status"],
    transcript: typeof m.transcript === "string" && transcripts.includes(m.transcript)
      ? (m.transcript as Meeting["transcript"]) : "none",
    summary: typeof m.summary === "string" && transcripts.includes(m.summary)
      ? (m.summary as Meeting["summary"]) : "none", // meetings saved before summaries existed
    transcriptError: typeof m.transcriptError === "string" ? m.transcriptError.slice(0, 300) : null,
    summaryError: typeof m.summaryError === "string" ? m.summaryError.slice(0, 300) : null,
  };
}
