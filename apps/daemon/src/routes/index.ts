// Route table: URL + schema -> controller. Schemas validate every input before a controller runs.
import type { FastifyInstance } from "fastify";
import type { Container } from "../container.ts";
import { meetingsController } from "../controllers/meetings.controller.ts";
import { systemController } from "../controllers/system.controller.ts";
import { MEETING_ID_PATTERN } from "../models/meeting.ts";
import { SETTINGS_SCHEMA } from "../models/settings.ts";
import type { SessionStore } from "../plugins/security.ts";

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: MEETING_ID_PATTERN.source } },
} as const;

export async function registerRoutes(app: FastifyInstance, c: Container, token: string, sessions: SessionStore, port: () => number): Promise<void> {
  const meetings = meetingsController(c);
  const system = systemController(c, token, sessions, port);

  app.post("/api/session", {
    schema: { body: { type: "object", additionalProperties: false, required: ["token"], properties: { token: { type: "string", maxLength: 256 } } } },
  }, system.session);
  app.get("/api/status", system.status);
  app.get("/api/jobs", system.jobs);
  app.get("/api/events", system.events);
  app.get("/api/settings", system.getSettings);
  app.put("/api/settings", { schema: { body: SETTINGS_SCHEMA } }, system.putSettings);

  app.get("/api/models", system.models);
  const engineParams = { type: "object", required: ["engine"], properties: { engine: { enum: ["whisper", "qwen"] } } } as const;
  app.post("/api/models/:engine/download", { schema: { params: engineParams } }, system.downloadModel);
  app.post("/api/models/:engine/cancel", { schema: { params: engineParams } }, system.cancelModel);
  app.get("/api/meetings", {
    schema: {
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          cursor: { type: "string", pattern: MEETING_ID_PATTERN.source },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  }, meetings.list);
  app.post("/api/meetings", meetings.start);
  app.get("/api/meetings/:id", { schema: { params: idParams } }, meetings.get);
  app.get("/api/meetings/:id/media", { schema: { params: idParams } }, meetings.media);
  app.post("/api/meetings/:id/stop", { schema: { params: idParams } }, meetings.stop);
  app.get("/api/meetings/:id/transcript", { schema: { params: idParams } }, meetings.transcript);
  app.post("/api/meetings/:id/transcribe", { schema: { params: idParams } }, meetings.transcribe);
  app.post("/api/meetings/:id/reveal", { schema: { params: idParams } }, meetings.reveal);
  app.post("/api/meetings/:id/share", {
    schema: { params: idParams, body: { type: "object", additionalProperties: false, required: ["what"], properties: { what: { enum: ["video", "original", "summary"] } } } },
  }, meetings.share);
  app.get("/api/meetings/:id/summary", { schema: { params: idParams } }, meetings.summary);
  app.get("/api/meetings/:id/summary.md", { schema: { params: idParams } }, meetings.summaryMarkdown);
  app.post("/api/meetings/:id/summarize", { schema: { params: idParams } }, meetings.summarize);
  app.delete("/api/meetings/:id", { schema: { params: idParams } }, meetings.remove);
}
