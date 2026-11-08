import { randomBytes } from "node:crypto";
import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { writeJsonAtomic } from "./fsAtomic.ts";

export interface RuntimeInfo { pid: number; port: number; token: string }

/**
 * Single-instance lock (daemon.lock holding the owner's pid).
 *
 * Creation is atomic WITH its content: the pid goes into a private temp file, which is then
 * hard-linked to daemon.lock. link() fails with EEXIST if the lock exists, so of several daemons
 * starting at once exactly one wins, and nobody ever sees an empty lock file.
 *
 * A lock whose owner is dead is stale. It is removed only if it still names that same dead pid,
 * then creation is retried. (Two starters racing over the same stale lock within microseconds is
 * the only remaining window; the agent never starts two daemons, so this is defense in depth.)
 */
export async function acquireLock(path: string, isAlive = pidAlive): Promise<"ok" | "running"> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, String(process.pid), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(tmp, path);
        return "ok";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = (await readFile(path, "utf8").catch(() => "")).trim();
      const pid = Number(holder);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) return "running";
      const current = (await readFile(path, "utf8").catch(() => "")).trim();
      if (current === holder) await rm(path, { force: true }); // still the same stale/corrupt lock
    }
    return "running";
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function releaseLock(path: string): Promise<void> {
  const pid = Number((await readFile(path, "utf8").catch(() => "")).trim());
  if (pid === process.pid) await rm(path, { force: true });
}

export const writeRuntime = (path: string, info: RuntimeInfo) => writeJsonAtomic(path, info, 0o600);

export async function releaseRuntime(path: string): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as Partial<RuntimeInfo>;
    if (existing.pid === process.pid) await rm(path, { force: true });
  } catch { /* already gone */ }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Keeps logs bounded: at startup, daemon.log over `maxBytes` becomes .1 (and .1 becomes .2). */
export async function rotateLog(path: string, maxBytes = 5 * 1024 * 1024, keep = 2): Promise<void> {
  try {
    if ((await stat(path)).size < maxBytes) return;
  } catch {
    return;
  }
  for (let i = keep - 1; i >= 1; i--) await rename(`${path}.${i}`, `${path}.${i + 1}`).catch(() => {});
  await rename(path, `${path}.1`);
}
