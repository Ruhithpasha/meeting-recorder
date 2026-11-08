import { afterEach, describe, expect, it, vi } from "vitest";
import { json, mockFetch } from "../test/fixtures.ts";
import { establishSession } from "./session.ts";

const TOKEN = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const loc = (hash: string) => ({ hash, pathname: "/", search: "" }) as Location;

afterEach(() => vi.unstubAllGlobals());

describe("establishSession", () => {
  it("removes the token from the URL BEFORE using it, then exchanges it for a cookie", async () => {
    const order: string[] = [];
    const history = { replaceState: vi.fn(() => order.push("replace")) } as unknown as History;
    const calls = mockFetch({ "POST /api/session": () => { order.push("post"); return new Response(null, { status: 204 }); } });
    expect(await establishSession(loc(`#t=${TOKEN}`), history)).toBe("ok");
    expect(order).toEqual(["replace", "post"]);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ token: TOKEN });
  });

  it("reports a rejected token", async () => {
    mockFetch({ "POST /api/session": () => json({ error: "Unauthorized" }, { status: 401 }) });
    expect(await establishSession(loc(`#t=${TOKEN}`), { replaceState: vi.fn() } as unknown as History)).toBe("rejected");
  });

  it("without a token, an existing cookie session still works", async () => {
    mockFetch({ "GET /api/status": () => json({}) });
    expect(await establishSession(loc(""), { replaceState: vi.fn() } as unknown as History)).toBe("ok");
  });

  it("without a token or cookie: no session", async () => {
    mockFetch({ "GET /api/status": () => json({ error: "Unauthorized" }, { status: 401 }) });
    expect(await establishSession(loc(""), { replaceState: vi.fn() } as unknown as History)).toBe("no-session");
  });

  it("ignores malformed fragments", async () => {
    mockFetch({ "GET /api/status": () => json({}, { status: 401 }) });
    const history = { replaceState: vi.fn() } as unknown as History;
    expect(await establishSession(loc("#t=<script>"), history)).toBe("no-session");
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
