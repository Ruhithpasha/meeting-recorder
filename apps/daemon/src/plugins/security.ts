// Local-only HTTP security for the daemon (bound to 127.0.0.1).
//
//  1. Host check: only "127.0.0.1:<port>" / "localhost:<port>". Blocks DNS rebinding, where a web
//     page you visit points its own hostname at 127.0.0.1 to reach this server.
//  2. Auth on /api/*: a per-launch 256-bit token, as a Bearer header (CLI) or an HttpOnly,
//     SameSite=Strict cookie set by POST /api/session (dashboard). No CORS headers are ever sent,
//     so other origins cannot read responses.
//  3. Strict CSP and related headers on every response: the dashboard can't load anything remote.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";

export const SESSION_COOKIE = "mr_session";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function tokenMatcher(token: string): (candidate: string | undefined) => boolean {
  const expected = Buffer.from(token);
  return (candidate) => {
    if (!candidate) return false;
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
}

export function registerSecurity(app: FastifyInstance, opts: { token: string; port: () => number }): void {
  const matches = tokenMatcher(opts.token);

  app.addHook("onRequest", async (request, reply) => {
    const port = opts.port();
    const host = request.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    // Authorize on the ROUTE the router matched, never the raw URL: the router percent-decodes paths,
    // so "/%61pi/meetings" reaches /api/meetings while a raw-URL check would see "/%61pi/...".
    // Unmatched requests have no route and fall through to the not-found handler (no data).
    const route = request.routeOptions.url;
    if (!route?.startsWith("/api/") || (request.method === "POST" && route === "/api/session")) return;

    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (matches(bearer) || matches(request.cookies[SESSION_COOKIE])) return;
    return reply.code(401).send({ error: "Unauthorized" });
  });

  app.addHook("onSend", async (_request, reply: FastifyReply, payload) => {
    reply.header("content-security-policy", CSP);
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("x-frame-options", "DENY");
    return payload;
  });
}
