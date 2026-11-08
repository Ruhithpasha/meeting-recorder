import { statfs } from "node:fs/promises";
import type { Logger } from "../repositories/MeetingRepository.ts";
import type { RecordingService } from "./RecordingService.ts";
import type { StatusService } from "./StatusService.ts";

export const MIN_FREE_BYTES = 2 * 1024 ** 3; // 2 GB
export const CHECK_INTERVAL_MS = 60_000;

/** Stops a recording before the disk fills, and refuses to start one without headroom. */
export class DiskGuardService {
  private interval: NodeJS.Timeout | null = null;
  private readonly root: string;
  private readonly log: Logger;
  private readonly freeBytes: (path: string) => Promise<number>;

  constructor(opts: { root: string; log: Logger; freeBytes?: (path: string) => Promise<number> }) {
    this.root = opts.root;
    this.log = opts.log;
    this.freeBytes = opts.freeBytes ?? (async (path) => { const s = await statfs(path); return s.bavail * s.bsize; });
  }

  /** On a statfs failure, assume there is space: a broken check must not block recording. */
  async hasSpace(): Promise<boolean> {
    try {
      return (await this.freeBytes(this.root)) >= MIN_FREE_BYTES;
    } catch (error) {
      this.log.warn({ error }, "free disk space check failed");
      return true;
    }
  }

  start(recording: RecordingService, status: StatusService): void {
    this.interval = setInterval(() => {
      void (async () => {
        if (recording.stateName !== "recording" || (await this.hasSpace())) return;
        status.setWarning("disk", "Recording stopped: less than 2 GB of disk space left.");
        await recording.dispatch({ type: "stop", reason: "disk" });
      })();
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }
}
