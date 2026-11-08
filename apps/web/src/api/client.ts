// Typed client for the daemon's API. Same origin, so the HttpOnly session cookie rides along.
import type { JobsInfo, Meeting, MeetingPage, MeetingSummary, Settings, Status, Transcript } from "@meeting-recorder/shared";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init.body ? { "content-type": "application/json", ...init.headers } : init.headers,
  });
  if (!response.ok) {
    let message = response.statusText || `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* non-JSON error body */ }
    throw new ApiError(response.status, message);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const api = {
  status: () => request<Status>("/api/status"),
  listMeetings: (cursor?: string, limit = 50) =>
    request<MeetingPage>(`/api/meetings?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
  getMeeting: (id: string) => request<Meeting>(`/api/meetings/${encodeURIComponent(id)}`),
  deleteMeeting: (id: string) => request<void>(`/api/meetings/${encodeURIComponent(id)}`, { method: "DELETE" }),
  startRecording: () => request<Status>("/api/meetings", { method: "POST" }),
  stopRecording: (id: string) => request<Status>(`/api/meetings/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  getSettings: () => request<Settings>("/api/settings"),
  putSettings: (settings: Settings) => request<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(settings) }),
  mediaUrl: (id: string) => `/api/meetings/${encodeURIComponent(id)}/media`,
  getTranscript: (id: string) => request<Transcript>(`/api/meetings/${encodeURIComponent(id)}/transcript`),
  getSummaryMarkdown: async (id: string) => {
    const response = await fetch(`/api/meetings/${encodeURIComponent(id)}/summary.md`, { credentials: "same-origin" });
    if (!response.ok) throw new ApiError(response.status, "Couldn't load the summary.");
    return response.text();
  },
  jobs: () => request<JobsInfo>("/api/jobs"),
  getSummary: (id: string) => request<MeetingSummary>(`/api/meetings/${encodeURIComponent(id)}/summary`),
  summarize: (id: string) => request<Meeting>(`/api/meetings/${encodeURIComponent(id)}/summarize`, { method: "POST" }),
  reveal: (id: string) => request<void>(`/api/meetings/${encodeURIComponent(id)}/reveal`, { method: "POST" }),
  transcribe: (id: string) => request<Meeting>(`/api/meetings/${encodeURIComponent(id)}/transcribe`, { method: "POST" }),
};
