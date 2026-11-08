import { Ajv } from "ajv";
import type { Settings } from "@meeting-recorder/shared";

/** One schema for both the PUT /api/settings body and settings.json read from disk. */
export const SETTINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["autoRecord", "quality", "transcription", "extraApps"],
  properties: {
    autoRecord: { type: "boolean" },
    quality: { enum: ["720p15", "1080p15", "720p10"] },
    transcription: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "model"],
      properties: { enabled: { type: "boolean" }, model: { enum: ["tiny", "base", "small"] } },
    },
    extraApps: {
      type: "array",
      maxItems: 50,
      items: { type: "string", maxLength: 200, pattern: "^[A-Za-z0-9.\\-]+\\*?$" },
    },
  },
} as const;

const validate = new Ajv({ strict: false }).compile<Settings>(SETTINGS_SCHEMA);

export const isValidSettings = (value: unknown): value is Settings => validate(value);
