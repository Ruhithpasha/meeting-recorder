import type { AgentStatus, RecorderState, Status } from "@meeting-recorder/shared";
import type { AgentPort } from "../agent/AgentChannel.ts";
import type { EventBus } from "./EventBus.ts";

export type WarningKey = "version" | "permission" | "disk" | "recording";

/**
 * Single place that composes what the user sees: recorder state, agent connection and warnings.
 * Every change is pushed to the dashboard (SSE) and the menu bar (state command).
 */
export class StatusService {
  private state: RecorderState = "idle";
  private meetingId: string | null = null;
  private label: string | null = null;
  private agentConnected = false;
  private readonly warnings = new Map<WarningKey, string>();
  private readonly bus: EventBus;
  private readonly agent: AgentPort;

  constructor(bus: EventBus, agent: AgentPort) {
    this.bus = bus;
    this.agent = agent;
  }

  get(): Status {
    const warning = this.warnings.values().next().value ?? null;
    return { state: this.state, meetingId: this.meetingId, agentConnected: this.agentConnected, warning };
  }

  setRecorder(state: RecorderState, meetingId: string | null, label: string | null): void {
    this.state = state;
    this.meetingId = meetingId;
    this.label = label;
    this.publish();
  }

  setAgentConnected(connected: boolean): void {
    this.agentConnected = connected;
    this.publish();
  }

  setWarning(key: WarningKey, message: string | null): void {
    if (message === null) {
      if (!this.warnings.delete(key)) return;
    } else {
      if (this.warnings.get(key) === message) return;
      this.warnings.set(key, message);
    }
    this.publish();
  }

  hasWarning(key: WarningKey): boolean {
    return this.warnings.has(key);
  }

  private publish(): void {
    const status = this.get();
    this.bus.publish({ type: "status", status });
    const menuStatus: AgentStatus = status.warning && this.state === "idle" ? "warning" : this.state;
    const label = status.warning && this.state === "idle"
      ? status.warning
      : this.state === "recording" ? `Recording ${this.label ?? ""}`.trim() : undefined;
    this.agent.send(label === undefined ? { cmd: "state", status: menuStatus } : { cmd: "state", status: menuStatus, label });
  }
}
