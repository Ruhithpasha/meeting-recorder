// HTTP integration tests through fastify.inject: real routes, controllers, services, temp folders.
import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@meeting-recorder/shared";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { AUTH, HOST, makeApp, makeContainer, TEST_PORT, TEST_TOKEN } from "./helpers/harness.ts";

async function withMeeting() {
  const ctx = await makeApp();
  await ctx.container.recording.toggle();
  const id = ctx.agent.starts[0]!.meetingId;
  await ctx.container.recording.dispatch({ type: "agentStarted", meetingId: id });
  writeFileSync(join(ctx.dirs.meetingsDir, id, "recording.mp4"), Buffer.from("0123456789abcdefghij"));
  await ctx.container.recording.dispatch({ type: "stop", reason: "manual" });
  await ctx.container.recording.dispatch({ type: "agentStopped", meetingId: id, durationSec: 2 });
  return { ...ctx, id };
}

describe("security", () => {
  it("rejects a foreign Host header (DNS rebinding) even with a valid token", async () => {
    const { app } = await makeApp();
    for (const host of ["evil.example.com", "127.0.0.1:9999", "localhost"]) {
      const res = await app.inject({ url: "/api/status", headers: { ...AUTH, host } });
      expect(res.statusCode).toBe(403);
    }
  });

  it("requires the token on /api/* (no token, wrong token)", async () => {
    const { app } = await makeApp();
    expect((await app.inject({ url: "/api/status", headers: HOST })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/status", headers: { ...HOST, authorization: "Bearer nope" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/status", headers: AUTH })).statusCode).toBe(200);
  });

  it.each(["/%61pi/status", "/%61pi/meetings", "/api/%6Deetings", "/%61%70%69/settings"])(
    "percent-encoded path %s cannot bypass the token check", async (url) => {
      const { app } = await makeApp();
      const res = await app.inject({ url, headers: HOST });
      expect(res.statusCode).toBe(401);
    });

  it("a percent-encoded POST cannot start a recording without the token", async () => {
    const { app, agent } = await makeApp();
    const res = await app.inject({ method: "POST", url: "/%61pi/meetings", headers: HOST });
    expect(res.statusCode).toBe(401);
    expect(agent.starts).toHaveLength(0);
  });

  async function sessionCookie(app: Awaited<ReturnType<typeof makeApp>>["app"]) {
    const res = await app.inject({ method: "POST", url: "/api/session", headers: HOST, payload: { token: TEST_TOKEN } });
    return { res, cookie: (res.headers["set-cookie"] as string).split(";")[0]! };
  }
  const ORIGIN = { origin: `http://127.0.0.1:${TEST_PORT}` };

  it("session: a per-port HttpOnly SameSite=Strict cookie with a random id (never the master token)", async () => {
    const { app } = await makeApp();
    const bad = await app.inject({ method: "POST", url: "/api/session", headers: HOST, payload: { token: "wrong" } });
    expect(bad.statusCode).toBe(401);
    const { res, cookie } = await sessionCookie(app);
    expect(res.statusCode).toBe(204);
    const header = res.headers["set-cookie"] as string;
    expect(header).toMatch(new RegExp(`^mr_session_${TEST_PORT}=`));
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(header).not.toContain(TEST_TOKEN);
    expect((await app.inject({ url: "/api/status", headers: { ...HOST, cookie } })).statusCode).toBe(200);
  });

  it("the master token in a cookie, or a cookie for another port, does not authorize", async () => {
    const { app } = await makeApp();
    for (const cookie of [`mr_session_${TEST_PORT}=${TEST_TOKEN}`, `mr_session=${TEST_TOKEN}`]) {
      expect((await app.inject({ url: "/api/status", headers: { ...HOST, cookie } })).statusCode).toBe(401);
    }
    const { cookie } = await sessionCookie(app);
    const otherPort = cookie.replace(`mr_session_${TEST_PORT}`, "mr_session_3000");
    expect((await app.inject({ url: "/api/status", headers: { ...HOST, cookie: otherPort } })).statusCode).toBe(401);
  });

  it("CSRF: a cookie-authenticated POST needs our own Origin (other local ports are rejected)", async () => {
    const { app, agent } = await makeApp();
    const { cookie } = await sessionCookie(app);
    for (const origin of [undefined, "http://127.0.0.1:3000", "http://evil.example.com", "null"]) {
      const headers = { ...HOST, cookie, ...(origin ? { origin } : {}) };
      expect((await app.inject({ method: "POST", url: "/api/meetings", headers })).statusCode).toBe(403);
    }
    expect(agent.starts).toHaveLength(0);
    const ok = await app.inject({ method: "POST", url: "/api/meetings", headers: { ...HOST, cookie, ...ORIGIN } });
    expect(ok.statusCode).toBe(202);
  });

  it("recordings can't be embedded by another origin (CORP same-origin)", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: "/", headers: HOST });
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("sends a strict CSP and no CORS headers", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: "/", headers: { ...HOST, origin: "https://evil.example.com" } });
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("the dashboard shell and assets are public (they contain no data)", async () => {
    const { app } = await makeApp();
    const index = await app.inject({ url: "/", headers: HOST });
    expect(index.statusCode).toBe(200);
    expect(index.headers["cache-control"]).toBe("no-cache");
    const asset = await app.inject({ url: "/assets/app-abc123.js", headers: HOST });
    expect(asset.headers["cache-control"]).toContain("immutable");
    const deepLink = await app.inject({ url: "/meetings/whatever", headers: HOST });
    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.body).toContain("Meeting Recorder");
  });

  it("unknown API paths are JSON 404s, not the SPA shell", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: "/api/nope", headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Not found" });
  });
});

describe("meetings API", () => {
  it("GET /api/meetings lists newest first; validates cursor and limit", async () => {
    const { app, id } = await withMeeting();
    const res = await app.inject({ url: "/api/meetings", headers: AUTH });
    expect(res.json()).toMatchObject({ items: [{ id, status: "complete", durationSec: 2 }], nextCursor: null });
    expect((await app.inject({ url: "/api/meetings?limit=0", headers: AUTH })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/meetings?limit=101", headers: AUTH })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/meetings?cursor=../../etc", headers: AUTH })).statusCode).toBe(400);
  });

  it("GET /api/meetings/:id: 200, 404, and 400 for a traversal attempt", async () => {
    const { app, id } = await withMeeting();
    expect((await app.inject({ url: `/api/meetings/${id}`, headers: AUTH })).json()).toMatchObject({ id });
    expect((await app.inject({ url: "/api/meetings/2020-01-01_00-00-00_none", headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/meetings/..%2F..%2Fetc", headers: AUTH })).statusCode).toBe(400);
  });

  it("GET media streams with Range support (seeking)", async () => {
    const { app, id } = await withMeeting();
    const full = await app.inject({ url: `/api/meetings/${id}/media`, headers: AUTH });
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    const part = await app.inject({ url: `/api/meetings/${id}/media`, headers: { ...AUTH, range: "bytes=10-14" } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe("abcde");
    const bad = await app.inject({ url: `/api/meetings/${id}/media`, headers: { ...AUTH, range: "bytes=999-" } });
    expect(bad.statusCode).toBe(416);
  });

  it("GET media is 404 when the recording file is missing", async () => {
    const { app, container, agent } = await makeApp();
    await container.recording.toggle();
    const res = await app.inject({ url: `/api/meetings/${agent.starts[0]!.meetingId}/media`, headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("POST start (202) then 409 while recording; stop requires the active id", async () => {
    const { app, agent, container } = await makeApp();
    const start = await app.inject({ method: "POST", url: "/api/meetings", headers: AUTH });
    expect(start.statusCode).toBe(202);
    expect(start.json()).toMatchObject({ state: "starting" });
    expect((await app.inject({ method: "POST", url: "/api/meetings", headers: AUTH })).statusCode).toBe(409);
    const id = agent.starts[0]!.meetingId;
    await container.recording.dispatch({ type: "agentStarted", meetingId: id });
    expect((await app.inject({ method: "POST", url: "/api/meetings/2020-01-01_00-00-00_x/stop", headers: AUTH })).statusCode).toBe(409);
    const stop = await app.inject({ method: "POST", url: `/api/meetings/${id}/stop`, headers: AUTH });
    expect(stop.statusCode).toBe(202);
    expect(stop.json()).toMatchObject({ state: "stopping" });
  });

  it("DELETE moves to trash (204), is 409 while recording, 404 when unknown", async () => {
    const { app, id, container, dirs } = await withMeeting();
    const del = await app.inject({ method: "DELETE", url: `/api/meetings/${id}`, headers: AUTH });
    expect(del.statusCode).toBe(204);
    expect(container.repo.get(id)).toBeUndefined();
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dirs.trashDir, id))).toBe(true);
    expect((await app.inject({ method: "DELETE", url: `/api/meetings/${id}`, headers: AUTH })).statusCode).toBe(404);

    await container.recording.toggle();
    const live = container.recording.currentMeetingId!;
    expect((await app.inject({ method: "DELETE", url: `/api/meetings/${live}`, headers: AUTH })).statusCode).toBe(409);
  });

  it("DELETE is 409 for a detached meeting the recorder may still be writing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { app, container, agent } = await makeApp();
      await container.recording.toggle();
      const id = agent.starts[0]!.meetingId;
      await container.recording.dispatch({ type: "agentStarted", meetingId: id });
      await container.recording.dispatch({ type: "stop", reason: "manual" });
      await vi.advanceTimersByTimeAsync(20_000);
      await container.recording.settled();
      expect(container.recording.stateName).toBe("idle");
      expect((await app.inject({ method: "DELETE", url: `/api/meetings/${id}`, headers: AUTH })).statusCode).toBe(409);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("settings API", () => {
  it("GET returns defaults; PUT validates, persists, and de-duplicates extra apps", async () => {
    const { app, dirs } = await makeApp();
    expect((await app.inject({ url: "/api/settings", headers: AUTH })).json()).toEqual(DEFAULT_SETTINGS);
    const next = { ...DEFAULT_SETTINGS, autoRecord: false, extraApps: ["com.hnc.Discord", "com.hnc.Discord", " "] };
    const bad = await app.inject({ method: "PUT", url: "/api/settings", headers: AUTH, payload: { ...next, extraApps: [" "] } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/api/settings", headers: AUTH, payload: { ...next, extraApps: ["com.hnc.Discord", "com.hnc.Discord"] } });
    expect(ok.json()).toMatchObject({ autoRecord: false, extraApps: ["com.hnc.Discord"] });
    const { readFileSync, statSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(join(dirs.stateDir, "settings.json"), "utf8")).autoRecord).toBe(false);
    expect(statSync(join(dirs.stateDir, "settings.json")).mode & 0o777).toBe(0o600);
  });

  it.each([
    [{ quality: "8k" }],
    [{ transcription: { enabled: true, summarize: "yes" } }],
    [{ transcription: { enabled: true, summarize: true, model: "base" } }],
    [{ extraApps: ["rm -rf /"] }],
    [{ surprise: true }],
  ])("PUT rejects %j", async (patch) => {
    const { app } = await makeApp();
    const res = await app.inject({ method: "PUT", url: "/api/settings", headers: AUTH, payload: { ...DEFAULT_SETTINGS, ...patch } });
    expect(res.statusCode).toBe(400);
  });
});

describe("shutdown", () => {
  it("app.close() finishes promptly even with an open dashboard event stream", async () => {
    const ctx = await makeContainer();
    let port = 0;
    const app = await buildApp({ container: ctx.container, token: TEST_TOKEN, port: () => port, webDist: ctx.dirs.webDist });
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/events", headers: { authorization: `Bearer ${TEST_TOKEN}` } }, (res) => {
        res.once("data", () => resolve()); // stream is open
        res.on("error", () => {});
      });
      req.on("error", () => {});
      req.end();
    });
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("events (SSE)", () => {
  it("streams the current status, then changes", async () => {
    const ctx = await makeContainer();
    let port = 0;
    const app = await buildApp({ container: ctx.container, token: TEST_TOKEN, port: () => port, webDist: ctx.dirs.webDist });
    await app.listen({ host: "127.0.0.1", port: 0 });
    port = (app.server.address() as AddressInfo).port;
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/events", headers: { authorization: `Bearer ${TEST_TOKEN}` } }, (res) => {
        expect(res.headers["content-type"]).toBe("text/event-stream");
        res.on("data", (d: Buffer) => {
          chunks.push(d.toString());
          if (chunks.length === 1) void ctx.container.recording.toggle();
          if (chunks.join("").includes('"type":"meeting"')) { req.destroy(); resolve(); }
        });
      });
      req.on("error", (e) => (e.message.includes("aborted") || e.message.includes("socket hang up") ? resolve() : reject(e)));
      req.end();
    });
    expect(chunks[0]).toContain('"state":"idle"');
    expect(chunks.join("")).toContain('"state":"starting"');
    await app.close();
  });
});

describe("transcript API", () => {
  it("GET transcript: 404 until done, then the JSON file", async () => {
    const { app, id, container, dirs } = await withMeeting();
    expect((await app.inject({ url: `/api/meetings/${id}/transcript`, headers: AUTH })).statusCode).toBe(404);
    writeFileSync(join(dirs.meetingsDir, id, "transcript.json"), JSON.stringify({ version: 1, segments: [{ start: 0, end: 1, speaker: "You", text: "hi" }] }));
    await container.repo.save({ ...container.repo.get(id)!, transcript: "done" });
    const res = await app.inject({ url: `/api/meetings/${id}/transcript`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().segments[0].text).toBe("hi");
  });

  it("POST transcribe: 409 with a reason when transcription is unavailable, 400 for bad ids", async () => {
    const { app, id } = await withMeeting(); // harness has no transcriber binary
    const res = await app.inject({ method: "POST", url: `/api/meetings/${id}/transcribe`, headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/isn't installed/);
    expect((await app.inject({ method: "POST", url: "/api/meetings/nope/transcribe", headers: AUTH })).statusCode).toBe(400);
  });
});

describe("reveal in Finder", () => {
  it("selects the recording in Finder; 404 without a file", async () => {
    const { app, id, revealed, dirs } = await withMeeting();
    const res = await app.inject({ method: "POST", url: `/api/meetings/${id}/reveal`, headers: AUTH });
    expect(res.statusCode).toBe(204);
    expect(revealed).toEqual([join(dirs.meetingsDir, id, "recording.mp4")]);
    expect((await app.inject({ method: "POST", url: "/api/meetings/2020-01-01_00-00-00_none/reveal", headers: AUTH })).statusCode).toBe(404);
  });
});

describe("models API", () => {
  it("GET /api/models reports each engine; download validates the engine and maps refusals to 409", async () => {
    const { app } = await makeApp(); // no transcriber installed
    const res = await app.inject({ url: "/api/models", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ whisper: { state: "unavailable", error: "Transcription isn't installed." }, qwen: { state: "unavailable", error: "Transcription isn't installed." } });
    const refused = await app.inject({ method: "POST", url: "/api/models/whisper/download", headers: AUTH });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/isn't installed/);
    expect((await app.inject({ method: "POST", url: "/api/models/gpt/download", headers: AUTH })).statusCode).toBe(400);
    const cancel = await app.inject({ method: "POST", url: "/api/models/whisper/cancel", headers: AUTH });
    expect(cancel.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/models/gpt/cancel", headers: AUTH })).statusCode).toBe(400);
    expect([401, 403]).toContain((await app.inject({ method: "POST", url: "/api/models/whisper/download" })).statusCode);
  });
});

describe("share API", () => {
  it("POST share opens the share sheet for the original; validates what to share", async () => {
    const { app, id, agent } = await withMeeting();
    const res = await app.inject({ method: "POST", url: `/api/meetings/${id}/share`, headers: AUTH, payload: { what: "original" } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ state: "shared" });
    expect(agent.last("share")).toEqual({ cmd: "share", meetingId: id, file: "recording.mp4" });
    for (const payload of [{ what: "../../etc/passwd" }, { what: "original", path: "/tmp/x" }, {}]) {
      expect((await app.inject({ method: "POST", url: `/api/meetings/${id}/share`, headers: AUTH, payload })).statusCode).toBe(400);
    }
    expect([401, 403]).toContain((await app.inject({ method: "POST", url: `/api/meetings/${id}/share`, payload: { what: "original" } })).statusCode); // no session
  });
});

describe("summary API", () => {
  it("GET summary: 404 until done, then the JSON; POST summarize needs a transcript", async () => {
    const { app, id, container, dirs } = await withMeeting();
    expect((await app.inject({ url: `/api/meetings/${id}/summary`, headers: AUTH })).statusCode).toBe(404);
    const res = await app.inject({ method: "POST", url: `/api/meetings/${id}/summarize`, headers: AUTH });
    expect(res.statusCode).toBe(409);
    writeFileSync(join(dirs.meetingsDir, id, "summary.json"), JSON.stringify({ version: 1, overview: "Sync.", keyPoints: [], decisions: [], actionItems: [] }));
    await container.repo.save({ ...container.repo.get(id)!, transcript: "done", summary: "done" });
    const got = await app.inject({ url: `/api/meetings/${id}/summary`, headers: AUTH });
    expect(got.statusCode).toBe(200);
    expect(got.json().overview).toBe("Sync.");
  });
});

describe("settings migration", () => {
  it("an older settings.json with the whisper model field loads (field dropped, choices kept)", async () => {
    const { tempDirs } = await import("./helpers/harness.ts");
    const dirs = tempDirs();
    writeFileSync(join(dirs.stateDir, "settings.json"), JSON.stringify({ autoRecord: false, quality: "1080p15", transcription: { enabled: true, model: "base" }, extraApps: [] }));
    const { SettingsRepository } = await import("../src/repositories/SettingsRepository.ts");
    const repo = new SettingsRepository(join(dirs.stateDir, "settings.json"));
    expect(await repo.load()).toEqual({ autoRecord: false, quality: "1080p15", transcription: { enabled: true, summarize: true, language: "auto", engine: "apple", summaryEngine: "apple" }, extraApps: [] });
  });
});

describe("jobs info and summary.md", () => {
  it("GET /api/jobs reports availability and languages (empty without a transcriber)", async () => {
    const { app } = await makeApp();
    const res = await app.inject({ url: "/api/jobs", headers: AUTH });
    expect(res.json()).toEqual({ transcriptUnavailable: "Transcription isn't installed.", summaryUnavailable: expect.stringMatching(/isn't installed/), languages: [], whisperLanguages: [],
      engines: { whisper: "Transcription isn't installed.", qwen: "Transcription isn't installed." } });
  });

  it("GET summary.md serves the saved Markdown (one source for Copy)", async () => {
    const { app, id, container, dirs } = await withMeeting();
    writeFileSync(join(dirs.meetingsDir, id, "summary.md"), "# Sync\n\nDone.\n");
    await container.repo.save({ ...container.repo.get(id)!, transcript: "done", summary: "done" });
    const res = await app.inject({ url: `/api/meetings/${id}/summary.md`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toBe("# Sync\n\nDone.\n");
  });
});
