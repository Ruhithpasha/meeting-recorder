// Local-only guarantee: booting the daemon's container and app and exercising the API must never
// open a network connection to anything other than loopback.
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTH, makeApp } from "./helpers/harness.ts";

const attempts: string[] = [];
const originalConnect = net.Socket.prototype.connect;

beforeAll(() => {
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const opts = args[0];
    const host = typeof opts === "object" && opts !== null ? String((opts as { host?: string }).host ?? "localhost") : String(args[1] ?? "localhost");
    if (!["127.0.0.1", "::1", "localhost"].includes(host)) attempts.push(host);
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
});
afterAll(() => { net.Socket.prototype.connect = originalConnect; });

describe("egress", () => {
  it("makes no non-loopback connections while booting and serving requests", async () => {
    const { app, container, agent } = await makeApp();
    for (const url of ["/", "/api/status", "/api/meetings", "/api/settings"]) await app.inject({ url, headers: AUTH });
    await container.recording.toggle();
    await container.recording.dispatch({ type: "agentStarted", meetingId: agent.starts[0]!.meetingId });
    await container.onAgentEvent({ type: "mic", users: [{ bundleId: "us.zoom.xos", pid: 1 }], windows: [] });
    expect(attempts).toEqual([]);
  });
});
