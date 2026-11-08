import { EventEmitter } from "node:events";
import type { ServerEvent } from "@meeting-recorder/shared";

/** In-process pub/sub for dashboard Server-Sent Events. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100); // one listener per open dashboard tab
  }

  publish(event: ServerEvent): void {
    this.emitter.emit("event", event);
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
