import type { Meeting, Status } from "@meeting-recorder/shared";
import { vi } from "vitest";

export const meeting = (n: number, extra: Partial<Meeting> = {}): Meeting => ({
  id: `2026-11-${String(10 + n).padStart(2, "0")}_10-00-00_zoom`,
  app: "Zoom",
  title: `Meeting ${n}`,
  startedAt: `2026-11-${String(10 + n).padStart(2, "0")}T10:00:00.000Z`,
  endedAt: null,
  durationSec: 1800,
  sizeBytes: 300 * 1024 * 1024,
  status: "complete",
  transcript: "none",
  summary: "none",
  ...extra,
});

export const status = (extra: Partial<Status> = {}): Status => ({
  state: "idle", meetingId: null, agentConnected: true, warning: null, ...extra,
});

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** Routes fetch calls by "METHOD path" to handlers; unknown calls fail the test loudly. */
export function mockFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const calls: { method: string; path: string; body?: string }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:47321");
    const method = init?.method ?? "GET";
    const key = `${method} ${url.pathname}${url.search}`;
    calls.push({ method, path: `${url.pathname}${url.search}`, body: init?.body as string | undefined });
    const handler = routes[key] ?? routes[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`unexpected fetch ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

/** Minimal EventSource stand-in (jsdom has none); tests push events through `emit`. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  closed = false;
  readyState = 0;
  static readonly CLOSED = 2;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  close() { this.closed = true; }
}
