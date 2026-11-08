import type { FastifyReply, FastifyRequest } from "fastify";
import type { JobsInfo, ModelEngine, Settings } from "@meeting-recorder/shared";
import type { Container } from "../container.ts";
import { sessionCookieName, tokenMatcher, type SessionStore } from "../plugins/security.ts";

export const SSE_HEARTBEAT_MS = 25_000;

export function systemController(c: Container, token: string, sessions: SessionStore, port: () => number) {
  const matches = tokenMatcher(token);
  return {
    /**
     * Exchanges the launch token (from the URL fragment) for an HttpOnly cookie holding a separate
     * random session id. The master token never goes into a cookie (cookies leak across ports).
     */
    session: async (request: FastifyRequest<{ Body: { token: string } }>, reply: FastifyReply) => {
      if (!matches(request.body.token)) return reply.code(401).send({ error: "Unauthorized" });
      return reply
        .setCookie(sessionCookieName(port()), sessions.create(), { httpOnly: true, sameSite: "strict", path: "/", secure: false })
        .code(204)
        .send();
    },

    status: async () => c.status.get(),

    jobs: async (): Promise<JobsInfo> => {
      const caps = await c.capabilities();
      return {
        transcriptUnavailable: c.transcription.unavailableFor("transcript"),
        summaryUnavailable: c.transcription.unavailableFor("summary"),
        languages: caps.locales,
        whisperLanguages: caps.whisperLanguages,
        engines: { whisper: caps.whisper, qwen: caps.qwen },
      };
    },

    models: async () => c.models.get(),

    downloadModel: async (request: FastifyRequest<{ Params: { engine: ModelEngine } }>, reply: FastifyReply) =>
      reply.code(202).send(await c.models.download(request.params.engine)),

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
