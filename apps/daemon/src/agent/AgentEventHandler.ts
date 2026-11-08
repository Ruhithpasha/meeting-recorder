// Routes validated agent events to services. The agent reports facts; the daemon decides.
import { PROTOCOL_VERSION, type AgentEvent } from "@meeting-recorder/shared";
import type { Logger } from "../repositories/MeetingRepository.ts";
import type { DetectionService } from "../services/DetectionService.ts";
import type { EventBus } from "../services/EventBus.ts";
import type { RecordingService } from "../services/RecordingService.ts";
import type { LiveTranscriptService } from "../services/LiveTranscriptService.ts";
import type { RecoveryService } from "../services/RecoveryService.ts";
import type { StatusService } from "../services/StatusService.ts";
import type { AgentPort } from "./AgentChannel.ts";

export interface AgentEventDeps {
  agent: AgentPort;
  recording: RecordingService;
  detection: DetectionService;
  recovery: RecoveryService;
  status: StatusService;
  bus: EventBus;
  live: LiveTranscriptService;
  log: Logger;
  dashboardUrl: () => string;
  openFolder: () => void;
  onPower?: (state: "ac" | "battery") => void;
}

export function createAgentEventHandler(d: AgentEventDeps) {
  return async (event: AgentEvent): Promise<void> => {
    switch (event.type) {
      case "hello": {
        d.status.setAgentConnected(true);
        const compatible = event.protocolVersion === PROTOCOL_VERSION;
        d.detection.setEnabled(compatible);
        d.status.setWarning("version", compatible ? null : "Agent and daemon versions differ. Run: meeting-recorder update");
        if (!compatible) d.log.warn({ agent: event.protocolVersion, daemon: PROTOCOL_VERSION }, "protocol version mismatch");
        if (event.activeMeetingId) await d.recording.dispatch({ type: "adopt", meetingId: event.activeMeetingId });
        // Only after hello: we now know which meeting (if any) is live and must not be touched.
        // Also skip anything the daemon itself has in flight (starting, recording, detached).
        const skip = d.recording.busyMeetingIds;
        if (event.activeMeetingId) skip.add(event.activeMeetingId);
        const { recovered, deleted } = await d.recovery.run(skip);
        for (const meeting of recovered) d.bus.publish({ type: "meeting", meeting });
        for (const id of deleted) d.bus.publish({ type: "meetingDeleted", id });
        return;
      }
      case "mic":
        d.detection.onMic(event);
        return;
      case "transcript":
        // Only for the meeting being recorded (or still saving): a stray line can't land elsewhere.
        if (!d.recording.busyMeetingIds.has(event.meetingId)) return;
        d.live.add(event.meetingId, { start: event.start, end: event.end, speaker: event.speaker, text: event.text });
        return;
      case "recording":
        if (event.state === "started") return d.recording.dispatch({ type: "agentStarted", meetingId: event.meetingId });
        if (event.state === "stopped") {
          return d.recording.dispatch({ type: "agentStopped", meetingId: event.meetingId, durationSec: event.durationSec ?? 0 });
        }
        return d.recording.dispatch({
          type: "agentError",
          meetingId: event.meetingId,
          code: event.error?.code ?? "unknown",
          message: event.error?.message ?? "The recorder reported an error.",
        });
      case "tray":
        if (event.action === "toggle") return d.recording.toggle();
        // Record only ever starts (a double click must not stop what the first click started).
        if (event.action === "record") {
          if (!d.detection.recordSuggested() && d.recording.stateName === "idle") await d.recording.toggle();
          return;
        }
        if (event.action === "openDashboard") return d.agent.send({ cmd: "openUrl", url: d.dashboardUrl() });
        if (event.action === "openFolder") return d.openFolder();
        // quit: finish the file cleanly; the agent waits for the idle state before exiting.
        if (d.recording.stateName !== "idle") return d.recording.dispatch({ type: "stop", reason: "quit" });
        return;
      case "power":
        if (event.state === "suspend") return d.recording.dispatch({ type: "stop", reason: "sleep" });
        if (event.state === "ac" || event.state === "battery") d.onPower?.(event.state);
        return;
      case "permission":
        d.status.setWarning("permission", event.screen === "denied"
          ? "Screen Recording permission is off. Open System Settings > Privacy & Security > Screen Recording."
          : null);
        return;
    }
  };
}
