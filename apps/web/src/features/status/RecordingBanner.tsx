import { useState } from "react";
import type { Status } from "@meeting-recorder/shared";
import { api } from "../../api/client.ts";
import { Button } from "../../components/ui.tsx";

const LABEL: Record<Status["state"], string> = {
  idle: "Not recording",
  starting: "Starting…",
  recording: "Recording",
  stopping: "Saving…",
};

/** Live recorder state with a start/stop control. Warnings (permissions, versions, disk) show here. */
export function RecordingBanner({ status }: { status: Status | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!status) return <div className="banner" aria-busy="true">Connecting to the recorder…</div>;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const live = status.state === "recording" || status.state === "starting";
  return (
    <section className={`banner${live ? " banner-live" : ""}`} aria-label="Recorder status">
      <div className="banner-state" role="status" aria-live="polite">
        {live && <span className="rec-dot" aria-hidden="true" />}
        <strong>{LABEL[status.state]}</strong>
        {!status.agentConnected && <span className="muted"> · menu-bar app not connected</span>}
      </div>
      {status.state === "idle" && (
        <Button variant="primary" disabled={busy || !status.agentConnected} onClick={() => act(api.startRecording)}>
          Start recording
        </Button>
      )}
      {status.state === "recording" && status.meetingId && (
        <Button variant="danger" disabled={busy} onClick={() => act(() => api.stopRecording(status.meetingId!))}>
          Stop
        </Button>
      )}
      {(status.warning || error) && <p className="banner-warning" role="alert">{error ?? status.warning}</p>}
    </section>
  );
}
