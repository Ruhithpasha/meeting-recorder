// Local-only HTTP security for the daemon (bound to 127.0.0.1).
//
//  1. Host check: only "127.0.0.1:<port>" / "localhost:<port>". Blocks DNS rebinding, where a web
//     page you visit points its own hostname at 127.0.0.1 to reach this server.
//  2. Auth on /api/*: the per-launch 256-bit token as a Bearer header (CLI), or a dashboard
//     session cookie. Cookies are scoped by HOST, not port, so other servers on 127.0.0.1 receive
//     them and "SameSite" treats every 127.0.0.1 port as the same site. Therefore:
//       - the cookie holds a separate random session id, never the master token;
//       - its name includes the port (mr_session_<port>);
//       - cookie-authenticated POST/PUT/DELETE must carry Origin: http://127.0.0.1:<port>
//         (CSRF: a page on another local port can't start recordings or change settings).
//     No CORS headers are ever sent, so other origins cannot read responses, and
//     Cross-Origin-Resource-Policy: same-origin stops them embedding recordings.
//  3. Strict CSP and related headers on every response: the dashboard can't load anything remote.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";

export const sessionCookieName = (port: number) => `mr_session_${port}`;

/** Dashboard sessions: random ids, kept in memory (a daemon restart ends them all). */
export class SessionStore {
  private readonly ids = new Set<string>();
  private static readonly MAX = 32;

  create(): string {
    const id = randomBytes(32).toString("base64url");
    this.ids.add(id);
    if (this.ids.size > SessionStore.MAX) this.ids.delete(this.ids.values().next().value!); // oldest
    return id;
  }

  has(id: string | undefined): boolean {
    if (!id) return false;
    for (const known of this.ids) if (tokenMatcher(known)(id)) return true;
    return false;
  }
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

export function registerSecurity(app: FastifyInstance, opts: { token: string; port: () => number; sessions: SessionStore }): void {
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
    if (matches(bearer)) return; // CLI: a custom header can't be sent cross-site without CORS

    if (!opts.sessions.has(request.cookies[sessionCookieName(port)])) return reply.code(401).send({ error: "Unauthorized" });
    if (MUTATING.has(request.method)) {
      const origin = request.headers.origin;
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        return reply.code(403).send({ error: "Forbidden" });
      }
    }
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
