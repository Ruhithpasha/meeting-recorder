import type { Meeting, MeetingPage } from "@meeting-recorder/shared";
import { conflict, notFound } from "../lib/errors.ts";
import type { MeetingRepository } from "../repositories/MeetingRepository.ts";
import type { EventBus } from "./EventBus.ts";
import type { RecordingService } from "./RecordingService.ts";

/** Read and delete meetings for the dashboard. Recording itself lives in RecordingService. */
export class MeetingService {
  private readonly repo: MeetingRepository;
  private readonly recording: RecordingService;
  private readonly bus: EventBus;

  constructor(repo: MeetingRepository, recording: RecordingService, bus: EventBus) {
    this.repo = repo;
    this.recording = recording;
    this.bus = bus;
  }

  list(cursor: string | undefined, limit: number): MeetingPage {
    return this.repo.list(cursor, limit);
  }

  get(id: string): Meeting {
    const meeting = this.repo.get(id);
    if (!meeting) throw notFound("Meeting");
    return meeting;
  }

  /** Folder and file name for streaming; the file must exist. */
  async media(id: string): Promise<{ dir: string; file: string }> {
    this.get(id);
    if (!(await this.repo.recordingSize(id))) throw notFound("Recording file");
    return { dir: this.repo.dir(id), file: "recording.mp4" };
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    // Includes detached meetings: the recorder may still be writing their file.
    if (this.recording.busyMeetingIds.has(id)) throw conflict("This recording is still being saved. Try again in a moment.");
    await this.repo.trash(id);
    this.bus.publish({ type: "meetingDeleted", id });
  }
}
