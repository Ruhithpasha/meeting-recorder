// Daemon entry point. Started by the native agent, which owns our stdin/stdout:
//
//   agent ──stdin (AgentEvent lines)──▶ this process ──stdout (DaemonCommand lines)──▶ agent
//
// Never write anything else to stdout. Logs go to ~/.meeting-recorder/logs/daemon.log.
// When stdin closes (agent quit or crashed) we shut down, so there is never an orphan daemon.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { AgentChannel, type AgentPort } from "./agent/AgentChannel.ts";
import { buildApp } from "./app.ts";
import { createContainer } from "./container.ts";
import { acquireLock, releaseLock, releaseRuntime, rotateLog, writeRuntime } from "./lib/runtime.ts";

const PREFERRED_PORT = Number(process.env.MR_PORT ?? 47321);
const home = process.env.MR_HOME ?? join(homedir(), ".meeting-recorder");
const meetingsDir = process.env.MR_MEETINGS_DIR ?? join(homedir(), "Meetings");
const webDist = process.env.MR_WEB_DIST ?? join(import.meta.dirname, "../../web/dist");
const runtimePath = join(home, "runtime.json");
const lockPath = join(home, "daemon.lock");
const logPath = join(home, "logs", "daemon.log");

async function main(): Promise<void> {
  await mkdir(join(home, "logs"), { recursive: true });
  if ((await acquireLock(lockPath)) === "running") {
    process.stderr.write("meeting-recorder daemon is already running\n");
    process.exit(2);
  }
  await rotateLog(logPath);
  const log = pino({ level: process.env.MR_LOG_LEVEL ?? "info" }, pino.destination({ dest: logPath, sync: false, mkdir: true }));

  const token = randomBytes(32).toString("base64url");
  let port = 0;
  let channel: AgentChannel | null = null;
  const agent: AgentPort = { send: (command) => channel?.send(command) };

  const container = await createContainer({
    meetingsDir,
    stateDir: home,
    agent,
    log,
    dashboardUrl: () => `http://127.0.0.1:${port}/#t=${token}`,
    openFolder: () => execFile("/usr/bin/open", [meetingsDir], (error) => error && log.warn({ error }, "open folder failed")),
    transcriberPath: process.env.MR_TRANSCRIBER ?? null,
    reveal: (path) => execFile("/usr/bin/open", ["-R", path], (error) => error && log.warn({ error }, "reveal failed")),
  });
  const app = await buildApp({ container, token, port: () => port, webDist, loggerInstance: log });

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, "daemon shutting down");
    // Hard deadline: whatever happens below, never outlive the agent.
    setTimeout(() => process.exit(0), 5_000).unref();
    container.stop();
    await app.close().catch(() => {});
    await releaseRuntime(runtimePath);
    await releaseLock(lockPath);
    log.flush();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await app.listen({ host: "127.0.0.1", port: PREFERRED_PORT });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    await app.listen({ host: "127.0.0.1", port: 0 }); // preferred port taken: any free port
  }
  const address = app.server.address();
  port = typeof address === "object" && address ? address.port : PREFERRED_PORT;
  await writeRuntime(runtimePath, { pid: process.pid, port, token });
  container.start();

  // Attach to the agent last: by the time we read its hello, everything above is ready.
  channel = new AgentChannel({
    input: process.stdin,
    output: process.stdout,
    log,
    onEvent: (event) => void container.onAgentEvent(event).catch((error: unknown) => log.warn({ error, event }, "agent event failed")),
    onClose: () => void shutdown("agent closed stdin"),
  });
  log.info({ port, meetingsDir }, "daemon ready");
}

main().catch((error: unknown) => {
  process.stderr.write(`daemon failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
