import { Ajv } from "ajv";
import type { Settings } from "@meeting-recorder/shared";

/** One schema for both the PUT /api/settings body and settings.json read from disk. */
export const SETTINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["autoRecord", "quality", "transcription", "extraApps"],
  properties: {
    autoRecord: { type: "boolean" },
    quality: { enum: ["720p30", "1080p30", "720p15", "1080p15", "720p10"] },
    transcription: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "summarize", "language", "engine", "summaryEngine"],
      properties: {
        enabled: { type: "boolean" },
        summarize: { type: "boolean" },
        language: { type: "string", pattern: "^(auto|[a-z]{2,3}(_[A-Z]{2})?)$" },
        engine: { enum: ["apple", "whisper"] },
        summaryEngine: { enum: ["apple", "qwen"] },
      },
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
