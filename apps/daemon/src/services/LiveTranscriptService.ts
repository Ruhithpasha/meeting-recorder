// The live transcript lines of recent meetings, in memory, so a dashboard opened (or reloaded)
// mid-meeting can show everything said so far: GET /api/meetings/:id/live. Bounded: the two most
// recent meetings, 5,000 lines each. A meeting's lines go once its real transcript is done or it's
// deleted (transcript.json is then the source).
import type { Transcript } from "@meeting-recorder/shared";
import type { EventBus } from "./EventBus.ts";

type Segment = Transcript["segments"][number];
const MAX_MEETINGS = 2;
const MAX_LINES = 5_000;

export class LiveTranscriptService {
  private readonly lines = new Map<string, Segment[]>();
  private readonly unsubscribe: () => void;
  private readonly bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
    this.unsubscribe = bus.subscribe((event) => {
      if (event.type === "meetingDeleted") this.lines.delete(event.id);
      else if (event.type === "meeting" && event.meeting.transcript === "done") this.lines.delete(event.meeting.id);
    });
  }

  add(id: string, segment: Segment): void {
    let list = this.lines.get(id);
    if (!list) {
      list = [];
      this.lines.set(id, list);
      for (const old of [...this.lines.keys()].slice(0, Math.max(0, this.lines.size - MAX_MEETINGS))) this.lines.delete(old);
    }
    if (list.length >= MAX_LINES) return;
    list.push(segment);
    this.bus.publish({ type: "liveTranscript", id, segment });
  }

  get(id: string): Segment[] {
    return this.lines.get(id) ?? [];
  }

  dispose(): void {
    this.unsubscribe();
  }
}
