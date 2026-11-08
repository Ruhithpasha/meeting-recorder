import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { ModelEngine, ServerEvent } from "@meeting-recorder/shared";
import { describe, expect, it, vi } from "vitest";
import { EventBus } from "./EventBus.ts";
import { ModelService } from "./ModelService.ts";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  // Like a real child process: "close" follows "exit" once stdout is done.
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const handled = super.emit(event, ...args);
    if (event === "exit") super.emit("close", ...args);
    return handled;
  }
  killed: string | null = null;
  readonly args: string[];
  constructor(args: string[]) { super(); this.args = args; }
  kill(signal: string) { this.killed = signal; return true; }
}

function setup(opts: { installed?: Record<ModelEngine, boolean>; unavailable?: Partial<Record<ModelEngine, string>>; transcriber?: string | null;
  jobUsing?: (e: ModelEngine) => boolean } = {}) {
  const bus = new EventBus();
  const events: ServerEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const children: FakeChild[] = [];
  let installed = opts.installed ?? { whisper: false, qwen: false };
  const service = new ModelService({
    bus, log: { info: () => {}, warn: () => {} },
    transcriberPath: opts.transcriber === undefined ? "/app/MeetingRecorderTranscriber" : opts.transcriber,
    modelsDir: "/models",
    unavailable: async (e) => opts.unavailable?.[e] ?? null,
    jobUsing: (e) => opts.jobUsing?.(e) ?? false,
    spawner: (_cmd, args) => { const c = new FakeChild(args); children.push(c); return c as unknown as ChildProcess; },
    status: async () => installed,
  });
  const onReady = vi.fn();
  service.onFinished = onReady;
  return { service, events, children, onReady, install: (v: Record<ModelEngine, boolean>) => { installed = v; } };
}

describe("ModelService", () => {
  it("reports what's downloaded and what this Mac can't run", async () => {
    const { service } = setup({ installed: { whisper: true, qwen: false }, unavailable: { qwen: "Needs 8 GB" } });
    expect(await service.get()).toEqual({ whisper: { state: "ready" }, qwen: { state: "unavailable", error: "Needs 8 GB" } });
  });

  it("downloads with progress, then marks ready and wakes waiting jobs", async () => {
    const { service, events, children, onReady, install } = setup();
    expect(await service.download("whisper")).toEqual({ state: "downloading", percent: 0 });
    expect(children[0]!.args).toEqual(["--prepare", "whisper", "--models", "/models"]);
    expect(service.isDownloading("whisper")).toBe(true);
    expect(await service.download("whisper")).toMatchObject({ state: "downloading" }); // second click: same download
    expect(children).toHaveLength(1);
    children[0]!.stdout.write('{"status":"downloading","percent":42,"what":"Whisper model"}\n');
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: "model", engine: "whisper", state: "downloading", percent: 42, what: "Whisper model" }));
    expect((await service.get()).whisper).toMatchObject({ state: "downloading", percent: 42 }); // not re-checked mid-download
    install({ whisper: true, qwen: false });
    children[0]!.emit("exit", 0);
    expect(events.at(-1)).toEqual({ type: "model", engine: "whisper", state: "ready" });
    expect(onReady).toHaveBeenCalledOnce();
    expect(service.isDownloading("whisper")).toBe(false);
  });

  it("shows the reason when a download fails, and keeps it until the next try", async () => {
    const { service, events, children, onReady } = setup();
    await service.download("qwen");
    children[0]!.stdout.write('{"error":"Couldn\'t download the Qwen model (HTTP 503). It will try again later."}\n');
    await new Promise((r) => setImmediate(r));
    children[0]!.emit("error", new Error("x"));
    children[0]!.emit("exit", 5); // reported once
    expect(events.filter((e) => e.type === "model" && e.state === "failed")).toHaveLength(1);
    expect((await service.get()).qwen).toEqual({ state: "failed", error: expect.stringMatching(/HTTP 503/) });
    expect(onReady).toHaveBeenCalledOnce(); // waiting jobs go on after a failure too
    await service.download("qwen");
    expect(children).toHaveLength(2);
  });

  it("refuses what can't be downloaded; nothing to do when ready", async () => {
    await expect(setup({ unavailable: { qwen: "Needs Apple silicon" } }).service.download("qwen")).rejects.toThrow(/Apple silicon/);
    await expect(setup({ transcriber: null }).service.download("whisper")).rejects.toThrow(/isn't installed/);
    const ready = setup({ installed: { whisper: true, qwen: true } });
    expect(await ready.service.download("whisper")).toEqual({ state: "ready" });
    expect(ready.children).toHaveLength(0);
  });

  it("two clicks at once start one download; a status check mid-download keeps 'downloading'", async () => {
    const { service, children } = setup();
    const [a, b] = await Promise.all([service.download("whisper"), service.download("whisper"), service.get()]);
    expect(children).toHaveLength(1);
    expect(a).toMatchObject({ state: "downloading" });
    expect(b).toMatchObject({ state: "downloading" });
    expect((await service.get()).whisper.state).toBe("downloading");
  });

  it("the last error line is reported even when it arrives just before exit", async () => {
    const { service, events, children } = setup();
    await service.download("whisper");
    children[0]!.stdout.end('{"error":"The downloaded Whisper model didn\'t match its pinned fingerprint, so it wasn\'t used."}\n');
    children[0]!.emit("exit", 6);
    await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ state: "failed", error: expect.stringMatching(/fingerprint/) }));
  });

  it("refuses while a meeting job is downloading the same model itself", async () => {
    const { service, children } = setup({ jobUsing: (e) => e === "whisper" });
    await expect(service.download("whisper")).rejects.toThrow(/Try again in a moment/);
    expect(children).toHaveLength(0);
  });

  it("stops downloads on shutdown", async () => {
    const { service, children } = setup();
    await service.download("whisper");
    service.dispose();
    expect(children[0]!.killed).toBe("SIGTERM");
  });
});
