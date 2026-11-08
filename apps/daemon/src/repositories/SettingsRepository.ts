import { readFile } from "node:fs/promises";
import { DEFAULT_SETTINGS, type Settings } from "@meeting-recorder/shared";
import { writeJsonAtomic } from "../lib/fsAtomic.ts";
import { isValidSettings } from "../models/settings.ts";

/** settings.json in the app's state folder. Missing, corrupt or invalid files fall back to defaults. */
export class SettingsRepository {
  private cached: Settings = structuredClone(DEFAULT_SETTINGS);
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<Settings>;
      // Defaults fill fields added in newer versions; anything still invalid resets to defaults.
      const merged = { ...DEFAULT_SETTINGS, ...raw, transcription: { ...DEFAULT_SETTINGS.transcription, ...raw.transcription } };
      this.cached = isValidSettings(merged) ? merged : structuredClone(DEFAULT_SETTINGS);
    } catch {
      this.cached = structuredClone(DEFAULT_SETTINGS);
    }
    return this.cached;
  }

  get(): Settings {
    return this.cached;
  }

  async save(settings: Settings): Promise<void> {
    await writeJsonAtomic(this.path, settings, 0o600);
    this.cached = settings;
  }
}
