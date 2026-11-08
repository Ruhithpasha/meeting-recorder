// Test harness: a real container on temp folders, with a fake agent that records every command.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { DaemonCommand, StartCommand } from "@meeting-recorder/shared";
import type { AgentPort } from "../../src/agent/AgentChannel.ts";
import { buildApp } from "../../src/app.ts";
import { createContainer } from "../../src/container.ts";
import type { Spawner } from "../../src/services/TranscriptionService.ts";

export const silentLog = { info: () => {}, warn: () => {} };

export class FakeAgent implements AgentPort {
  readonly sent: DaemonCommand[] = [];
  send(command: DaemonCommand): void {
    this.sent.push(command);
  }
  last<T extends DaemonCommand["cmd"]>(cmd: T): Extract<DaemonCommand, { cmd: T }> | undefined {
    return this.sent.filter((c): c is Extract<DaemonCommand, { cmd: T }> => c.cmd === cmd).at(-1);
  }
  get starts(): StartCommand[] {
    return this.sent.filter((c): c is StartCommand => c.cmd === "start");
  }
}

export function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), "mr-test-"));
  const meetingsDir = join(root, "Meetings");
  const stateDir = join(root, "state");
  const trashDir = join(root, "Trash");
  const webDist = join(root, "web");
  for (const d of [meetingsDir, stateDir, trashDir, webDist]) mkdirSync(d, { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<!doctype html><title>Meeting Recorder</title><div id=root></div>");
  mkdirSync(join(webDist, "assets"));
  writeFileSync(join(webDist, "assets", "app-abc123.js"), "console.log('app')");
  return { root, meetingsDir, stateDir, trashDir, webDist };
}

export async function makeContainer(opts: { freeBytes?: number; transcriberPath?: string | null; spawner?: Spawner } = {}) {
  const dirs = tempDirs();
  const agent = new FakeAgent();
  const opened: string[] = [];
  const container = await createContainer({
    meetingsDir: dirs.meetingsDir,
    stateDir: dirs.stateDir,
    agent,
    log: silentLog,
    dashboardUrl: () => "http://127.0.0.1:47321/#t=test",
    openFolder: () => opened.push(dirs.meetingsDir),
    trashItem: (path) => rename(path, join(dirs.trashDir, basename(path))),
    freeBytes: async () => opts.freeBytes ?? 100 * 1024 ** 3,
    transcriberPath: opts.transcriberPath ?? null,
    spawner: opts.spawner,
  });
  return { container, agent, dirs, opened };
}

export const TEST_PORT = 47321;
export const TEST_TOKEN = "t".repeat(43);
export const HOST = { host: `127.0.0.1:${TEST_PORT}` };
export const AUTH = { ...HOST, authorization: `Bearer ${TEST_TOKEN}` };

export async function makeApp(opts: { freeBytes?: number } = {}) {
  const ctx = await makeContainer(opts);
  const app = await buildApp({ container: ctx.container, token: TEST_TOKEN, port: () => TEST_PORT, webDist: ctx.dirs.webDist });
  return { ...ctx, app };
}

/** Writes a minimal valid fragmented-looking recording file for a meeting. */
export function writeRecording(dir: string, bytes: Buffer): void {
  writeFileSync(join(dir, "recording.mp4"), bytes);
}
