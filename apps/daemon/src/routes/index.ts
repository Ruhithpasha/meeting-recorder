// Route table: URL + schema -> controller. Schemas validate every input before a controller runs.
import type { FastifyInstance } from "fastify";
import type { Container } from "../container.ts";
import { meetingsController } from "../controllers/meetings.controller.ts";
import { systemController } from "../controllers/system.controller.ts";
import { MEETING_ID_PATTERN } from "../models/meeting.ts";
import { SETTINGS_SCHEMA } from "../models/settings.ts";

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: MEETING_ID_PATTERN.source } },
} as const;

export async function registerRoutes(app: FastifyInstance, c: Container, token: string): Promise<void> {
  const meetings = meetingsController(c);
  const system = systemController(c, token);

  app.post("/api/session", {
    schema: { body: { type: "object", additionalProperties: false, required: ["token"], properties: { token: { type: "string", maxLength: 256 } } } },
  }, system.session);
  app.get("/api/status", system.status);
  app.get("/api/events", system.events);
  app.get("/api/settings", system.getSettings);
  app.put("/api/settings", { schema: { body: SETTINGS_SCHEMA } }, system.putSettings);

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
  app.delete("/api/meetings/:id", { schema: { params: idParams } }, meetings.remove);
}
