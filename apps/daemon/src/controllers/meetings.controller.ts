import type { FastifyReply, FastifyRequest } from "fastify";
import type { ShareWhat } from "@meeting-recorder/shared";
import type { Container } from "../container.ts";
import { conflict, notFound } from "../lib/errors.ts";

type IdRequest = FastifyRequest<{ Params: { id: string } }>;
type ListRequest = FastifyRequest<{ Querystring: { cursor?: string; limit?: number } }>;

/** Thin: parse the request, call a service, shape the reply. */
export function meetingsController(c: Container) {
  return {
    list: async (request: ListRequest) => c.meetings.list(request.query.cursor, request.query.limit ?? 50),

    get: async (request: IdRequest) => c.meetings.get(request.params.id),

    media: async (request: IdRequest, reply: FastifyReply) => {
      const { dir, file } = await c.meetings.media(request.params.id);
      return reply.header("cache-control", "no-store").sendFile(file, dir); // supports Range (seeking)
    },

    remove: async (request: IdRequest, reply: FastifyReply) => {
      await c.meetings.remove(request.params.id);
      return reply.code(204).send();
    },

    start: async (_request: FastifyRequest, reply: FastifyReply) => {
      if (c.recording.stateName !== "idle") throw conflict("Already recording.");
      await c.recording.dispatch({ type: "start", trigger: { app: "Manual", title: "Manual recording", source: "manual" } });
      return reply.code(202).send(c.status.get());
    },

    share: async (request: FastifyRequest<{ Params: { id: string }; Body: { what: ShareWhat } }>, reply: FastifyReply) =>
      reply.code(202).send(await c.share.share(request.params.id, request.body.what)),

    reveal: async (request: IdRequest, reply: FastifyReply) => {
      const { dir, file } = await c.meetings.media(request.params.id);
      c.reveal(`${dir}/${file}`);
      return reply.code(204).send();
    },

    transcript: async (request: IdRequest, reply: FastifyReply) => {
      const meeting = c.meetings.get(request.params.id);
      if (meeting.transcript !== "done") throw notFound("Transcript");
      return reply.header("cache-control", "no-store").type("application/json").sendFile("transcript.json", c.repo.dir(meeting.id));
    },

    transcribe: async (request: IdRequest, reply: FastifyReply) => {
      return reply.code(202).send(await c.transcription.enqueue(request.params.id, "transcript"));
    },

    summary: async (request: IdRequest, reply: FastifyReply) => {
      const meeting = c.meetings.get(request.params.id);
      if (meeting.summary !== "done") throw notFound("Summary");
      return reply.header("cache-control", "no-store").type("application/json").sendFile("summary.json", c.repo.dir(meeting.id));
    },

    summaryMarkdown: async (request: IdRequest, reply: FastifyReply) => {
      const meeting = c.meetings.get(request.params.id);
      if (meeting.summary !== "done") throw notFound("Summary");
      return reply.header("cache-control", "no-store").type("text/markdown; charset=utf-8").sendFile("summary.md", c.repo.dir(meeting.id));
    },

    summarize: async (request: IdRequest, reply: FastifyReply) => {
      return reply.code(202).send(await c.transcription.enqueue(request.params.id, "summary"));
    },

    stop: async (request: IdRequest, reply: FastifyReply) => {
      if (c.recording.currentMeetingId !== request.params.id) throw conflict("That meeting isn't recording.");
      await c.recording.dispatch({ type: "stop", reason: "manual" });
      return reply.code(202).send(c.status.get());
    },
  };
}
