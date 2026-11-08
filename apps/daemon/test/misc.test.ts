import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { acquireLock, releaseLock, releaseRuntime, rotateLog, writeRuntime } from "../src/lib/runtime.ts";
import { DiskGuardService, CHECK_INTERVAL_MS, MIN_FREE_BYTES } from "../src/services/DiskGuardService.ts";
import { makeContainer, silentLog } from "./helpers/harness.ts";

const dir = () => mkdtempSync(join(tmpdir(), "mr-misc-"));

describe("daemon.lock (single instance)", () => {
  it("is acquired when missing, corrupt, or left by a dead process", async () => {
    const p = join(dir(), "daemon.lock");
    expect(await acquireLock(p)).toBe("ok");
    expect(readFileSync(p, "utf8")).toBe(String(process.pid));
    writeFileSync(p, "garbage");
    expect(await acquireLock(p)).toBe("ok");
    writeFileSync(p, "999999");
    expect(await acquireLock(p, () => false)).toBe("ok");
  });

  it("refuses when another live process holds it, and is only released by its owner", async () => {
    const p = join(dir(), "daemon.lock");
    writeFileSync(p, String(process.pid + 1));
    expect(await acquireLock(p, () => true)).toBe("running");
    await releaseLock(p);
    expect(existsSync(p)).toBe(true);
    writeFileSync(p, String(process.pid));
    await releaseLock(p);
    expect(existsSync(p)).toBe(false);
  });

  it("exactly one of several daemons starting at the same moment wins (O_EXCL)", async () => {
    const p = join(dir(), "daemon.lock");
    const runtime = join(import.meta.dirname, "../src/lib/runtime.ts");
    const script = `import { acquireLock } from ${JSON.stringify(runtime)}; console.log(await acquireLock(${JSON.stringify(p)})); setTimeout(() => {}, 800);`;
    const results = await Promise.all(Array.from({ length: 5 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.on("exit", () => resolve(out.trim()));
      child.on("error", reject);
    })));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "running")).toHaveLength(4);
  }, 15_000);
});

describe("runtime.json (CLI discovery)", () => {
  it("is written 0600 and only released by its owner", async () => {
    const p = join(dir(), "runtime.json");
    await writeRuntime(p, { pid: process.pid, port: 47321, token: "secret" });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ pid: process.pid, port: 47321, token: "secret" });
    await releaseRuntime(p);
    expect(existsSync(p)).toBe(false);

    writeFileSync(p, JSON.stringify({ pid: 1, port: 1, token: "other" }));
    await releaseRuntime(p);
    expect(existsSync(p)).toBe(true);
  });
});

describe("rotateLog", () => {
  it("rotates only past the size limit, keeping two old files", async () => {
    const p = join(dir(), "daemon.log");
    writeFileSync(p, "small");
    await rotateLog(p, 100);
    expect(existsSync(`${p}.1`)).toBe(false);
    for (const gen of ["a", "b", "c"]) {
      writeFileSync(p, gen.repeat(200));
      await rotateLog(p, 100);
    }
    expect(readFileSync(`${p}.1`, "utf8")[0]).toBe("c");
    expect(readFileSync(`${p}.2`, "utf8")[0]).toBe("b");
    expect(existsSync(`${p}.3`)).toBe(false);
  });

  it("does nothing when the log doesn't exist", async () => {
    await expect(rotateLog(join(dir(), "none.log"))).resolves.toBeUndefined();
  });
});

describe("DiskGuardService", () => {
  afterEach(() => vi.useRealTimers());

  it("hasSpace compares against 2 GB; a failing check doesn't block recording", async () => {
    const at = (n: number) => new DiskGuardService({ root: "/", log: silentLog, freeBytes: async () => n });
    expect(await at(MIN_FREE_BYTES).hasSpace()).toBe(true);
    expect(await at(MIN_FREE_BYTES - 1).hasSpace()).toBe(false);
    const broken = new DiskGuardService({ root: "/", log: silentLog, freeBytes: async () => { throw new Error("EIO"); } });
    expect(await broken.hasSpace()).toBe(true);
  });

  it("stops an active recording when space runs low, with a warning", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let free = 100 * 1024 ** 3;
    const { container: c, agent } = await makeContainer();
    const guard = new DiskGuardService({ root: "/", log: silentLog, freeBytes: async () => free });
    await c.recording.toggle();
    await c.recording.dispatch({ type: "agentStarted", meetingId: agent.starts[0]!.meetingId });
    guard.start(c.recording, c.status);
    free = 1024;
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    await c.recording.settled();
    expect(c.recording.stateName).toBe("stopping");
    expect(c.status.get().warning).toMatch(/disk space/);
    guard.stop();
  });
});
