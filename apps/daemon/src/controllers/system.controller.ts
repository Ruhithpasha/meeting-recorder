import type { FastifyReply, FastifyRequest } from "fastify";
import type { Settings } from "@meeting-recorder/shared";
import type { Container } from "../container.ts";
import { SESSION_COOKIE, tokenMatcher } from "../plugins/security.ts";

export const SSE_HEARTBEAT_MS = 25_000;

export function systemController(c: Container, token: string) {
  const matches = tokenMatcher(token);
  return {
    /** Exchanges the launch token (from the URL fragment) for an HttpOnly session cookie. */
    session: async (request: FastifyRequest<{ Body: { token: string } }>, reply: FastifyReply) => {
      if (!matches(request.body.token)) return reply.code(401).send({ error: "Unauthorized" });
      return reply
        .setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "strict", path: "/", secure: false })
        .code(204)
        .send();
    },

    status: async () => c.status.get(),

    getSettings: async () => c.settings.get(),

    putSettings: async (request: FastifyRequest<{ Body: Settings }>) => c.settings.update(request.body),

    /** Server-Sent Events: current status first, then every change. */
    events: async (request: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({ type: "status", status: c.status.get() });
      const unsubscribe = c.bus.subscribe(send);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  };
}
