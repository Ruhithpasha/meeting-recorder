// Composition root: builds repositories and services and wires them together (dependency injection
// by hand; no framework). Tests call this with temp folders and a fake agent.
import { execFile } from "node:child_process";
import { join } from "node:path";
import trash from "trash";
import type { AgentPort } from "./agent/AgentChannel.ts";
import { createAgentEventHandler } from "./agent/AgentEventHandler.ts";
import { MeetingRepository, type Logger } from "./repositories/MeetingRepository.ts";
import { SettingsRepository } from "./repositories/SettingsRepository.ts";
import { DetectionService } from "./services/DetectionService.ts";
import { DiskGuardService } from "./services/DiskGuardService.ts";
import { EventBus } from "./services/EventBus.ts";
import { MeetingService } from "./services/MeetingService.ts";
import { RecordingService } from "./services/RecordingService.ts";
import { RecoveryService } from "./services/RecoveryService.ts";
import { SettingsService } from "./services/SettingsService.ts";
import { StatusService } from "./services/StatusService.ts";
import { TranscriptionService, type Spawner } from "./services/TranscriptionService.ts";

export interface ContainerOptions {
  meetingsDir: string;
  stateDir: string;
  agent: AgentPort;
  log: Logger;
  dashboardUrl: () => string;
  openFolder: () => void;
  /** Selects a file in Finder (open -R). */
  reveal?: (path: string) => void;
  trashItem?: (path: string) => Promise<void>;
  freeBytes?: (path: string) => Promise<number>;
  /** MeetingRecorderTranscriber inside the app bundle (MR_TRANSCRIBER); null disables transcription. */
  transcriberPath?: string | null;
  spawner?: Spawner;
}

export async function createContainer(o: ContainerOptions) {
  const bus = new EventBus();
  const status = new StatusService(bus, o.agent);
  const repo = new MeetingRepository({
    root: o.meetingsDir,
    log: o.log,
    trashItem: o.trashItem ?? ((path) => trash(path)),
    onExternalDelete: (id) => bus.publish({ type: "meetingDeleted", id }),
  });
  await repo.init();
  const settingsRepo = new SettingsRepository(join(o.stateDir, "settings.json"));
  await settingsRepo.load();

  const settings = new SettingsService(settingsRepo);
  const recovery = new RecoveryService(repo, o.log);
  const disk = new DiskGuardService({ root: o.meetingsDir, log: o.log, freeBytes: o.freeBytes });
  const recording = new RecordingService({
    repo, agent: o.agent, status, bus, recovery, log: o.log,
    settings: () => settings.get(),
    hasDiskSpace: () => disk.hasSpace(),
  });
  const detection = new DetectionService({ recording, settings: () => settings.get(), log: o.log, bus });
  const meetings = new MeetingService(repo, recording, bus);
  const transcription = new TranscriptionService({
    repo, bus, recording, log: o.log, settings: () => settings.get(),
    transcriberPath: o.transcriberPath ?? null, spawner: o.spawner,
  });
  settings.onChange = () => transcription.settingsChanged();
  await transcription.init();

  /** Languages the on-device transcriber supports (asked once, then cached). */
  let languages: Promise<string[]> | null = null;
  // Cached only when it worked: a slow first call (speech service still starting) is retried next time.
  const listLanguages = () => (languages ??= o.transcriberPath
    ? new Promise<string[]>((resolve) => {
        execFile(o.transcriberPath!, ["--list-locales"], { timeout: 15_000 }, (error, stdout) => {
          let list: string[] = [];
          try { if (!error) list = (JSON.parse(stdout) as string[]).filter((l) => /^[a-z]{2,3}(_[A-Z]{2})?$/.test(l)); }
          catch { /* treated as a failed call */ }
          if (!list.length) languages = null;
          resolve(list);
        });
      })
    : Promise.resolve([]));
  const onAgentEvent = createAgentEventHandler({
    agent: o.agent, recording, detection, recovery, status, bus, log: o.log,
    dashboardUrl: o.dashboardUrl, openFolder: o.openFolder,
    onPower: (state) => transcription.setPower(state),
  });

  return {
    bus, status, repo, settings, recovery, disk, recording, detection, meetings, transcription, onAgentEvent,
    reveal: o.reveal ?? (() => {}),
    listLanguages,
    start() {
      repo.startWatching();
      disk.start(recording, status);
    },
    stop() {
      repo.stopWatching();
      disk.stop();
      detection.dispose();
      transcription.dispose();
    },
  };
}

export type Container = Awaited<ReturnType<typeof createContainer>>;
