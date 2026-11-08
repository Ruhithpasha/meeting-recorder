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
import { LiveTranscriptService } from "./services/LiveTranscriptService.ts";
import { MergeService } from "./services/MergeService.ts";
import { ModelService } from "./services/ModelService.ts";
import { ShareService } from "./services/ShareService.ts";
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

export interface Capabilities { locales: string[]; whisperLanguages: string[]; whisper: string | null; qwen: string | null }

/** Narrow parse of `MeetingRecorderTranscriber --capabilities` output (null if malformed). */
export function parseCapabilities(stdout: string): Capabilities | null {
  try {
    const raw = JSON.parse(stdout) as Record<string, unknown>;
    const reason = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : null);
    if (!Array.isArray(raw.locales)) return null;
    const ids = (v: unknown, pattern: RegExp) => (Array.isArray(v) ? v : []).filter((l): l is string => typeof l === "string" && pattern.test(l));
    return {
      locales: ids(raw.locales, /^[a-z]{2,3}(_[A-Z]{2})?$/),
      whisperLanguages: ids(raw.whisperLanguages, /^[a-z]{2,3}$/),
      whisper: reason(raw.whisper),
      qwen: reason(raw.qwen),
    };
  } catch {
    return null;
  }
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
  const merge = new MergeService({ repo, log: o.log, transcriberPath: o.transcriberPath ?? null, spawner: o.spawner });
  const recovery = new RecoveryService(repo, o.log, merge);
  const disk = new DiskGuardService({ root: o.meetingsDir, log: o.log, freeBytes: o.freeBytes });
  const recording = new RecordingService({
    repo, agent: o.agent, status, bus, recovery, log: o.log,
    settings: () => settings.get(),
    hasDiskSpace: () => disk.hasSpace(),
    merge,
  });
  const detection = new DetectionService({ recording, settings: () => settings.get(), log: o.log, bus });
  const meetings = new MeetingService(repo, recording, bus);
  const models = new ModelService({
    bus, log: o.log, transcriberPath: o.transcriberPath ?? null, modelsDir: join(o.stateDir, "models"), spawner: o.spawner,
    // getCapabilities/unknown are defined below; these run only later. "Not checked yet" isn't "unavailable".
    unavailable: async (engine) => { const reason = (await getCapabilities())[engine]; return reason === unknown ? null : reason; },
    jobUsing: (engine) => transcription.isRunningEngine(engine),
  });
  const transcription = new TranscriptionService({
    repo, bus, recording, log: o.log, settings: () => settings.get(),
    transcriberPath: o.transcriberPath ?? null, modelsDir: join(o.stateDir, "models"), spawner: o.spawner,
    modelBusy: (engine) => models.holdsJobs(engine),
  });
  settings.onChange = () => transcription.settingsChanged();
  models.onFinished = () => transcription.pump();
  const share = new ShareService({ repo, bus, agent: o.agent, recording, log: o.log, transcriberPath: o.transcriberPath ?? null, spawner: o.spawner });
  await transcription.init();

  /** What the transcriber can do here: Apple's languages, and why an open-model engine can't run
   *  (e.g. Intel Mac, too little memory). Asked once; cached only when the call worked, so a slow
   *  first call (speech service still starting) is retried next time. */
  const noCapabilities: Capabilities = { locales: [], whisperLanguages: [], whisper: "Transcription isn't installed.", qwen: "Transcription isn't installed." };
  const unknown = "Couldn't check this Mac yet. Open Settings again in a moment.";
  let capabilities: Promise<Capabilities> | null = null;
  const getCapabilities = () => (capabilities ??= o.transcriberPath
    ? new Promise<Capabilities>((resolve) => {
        execFile(o.transcriberPath!, ["--capabilities"], { timeout: 15_000 }, (error, stdout) => {
          const parsed = error ? null : parseCapabilities(stdout);
          if (!parsed) capabilities = null;
          resolve(parsed ?? { ...noCapabilities, whisper: unknown, qwen: unknown }); // unknown ≠ available
        });
      })
    : Promise.resolve(noCapabilities));
  const live = new LiveTranscriptService(bus);
  const onAgentEvent = createAgentEventHandler({
    agent: o.agent, recording, detection, recovery, status, bus, live, log: o.log,
    dashboardUrl: o.dashboardUrl, openFolder: o.openFolder,
    onPower: (state) => transcription.setPower(state),
  });

  return {
    bus, status, repo, settings, recovery, disk, recording, detection, meetings, transcription, share, models, live, onAgentEvent,
    reveal: o.reveal ?? (() => {}),
    capabilities: getCapabilities,
    start() {
      repo.startWatching();
      disk.start(recording, status);
    },
    stop() {
      repo.stopWatching();
      disk.stop();
      detection.dispose();
      transcription.dispose();
      share.dispose();
      models.dispose();
      live.dispose();
    },
  };
}

export type Container = Awaited<ReturnType<typeof createContainer>>;
