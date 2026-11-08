import type { Settings } from "@meeting-recorder/shared";
import type { SettingsRepository } from "../repositories/SettingsRepository.ts";

export class SettingsService {
  private readonly repo: SettingsRepository;

  constructor(repo: SettingsRepository) {
    this.repo = repo;
  }

  get(): Settings {
    return this.repo.get();
  }

  /** Input is already validated by the route schema; de-duplicate the extra apps list. */
  async update(next: Settings): Promise<Settings> {
    const settings: Settings = { ...next, extraApps: [...new Set(next.extraApps.map((s) => s.trim()).filter(Boolean))] };
    await this.repo.save(settings);
    return settings;
  }
}
