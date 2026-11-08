import { useEffect, useState } from "react";
import type { Meeting, Status } from "@meeting-recorder/shared";
import { api } from "../../api/client.ts";
import { formatDuration } from "../../components/format.ts";
import { Button } from "../../components/ui.tsx";

const LABEL: Record<Status["state"], string> = {
  idle: "Not recording",
  starting: "Starting…",
  recording: "Recording",
  stopping: "Saving…",
};

/** Live recorder state with a start/stop control and elapsed time. Warnings show here too. */
export function RecordingBanner({ status, meeting }: { status: Status | null; meeting?: Meeting | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const live = status?.state === "recording" || status?.state === "starting";

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

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

  const elapsed = meeting && live ? formatDuration(Math.max(0, (now - Date.parse(meeting.startedAt)) / 1000)) : null;
  const label = LABEL[status.state];

  return (
    <section className={`banner${live ? " banner-live" : ""}`} aria-label="Recorder status">
      <div className="banner-state" role="status" aria-live="polite">
        {live && <span className="rec-dot" aria-hidden="true" />}
        <strong>{label}</strong>
        {live && meeting && <span className="muted"> · {meeting.app}</span>}
        {elapsed && <span className="banner-timer">{elapsed}</span>}
        {status.state === "idle" && status.agentConnected && <span className="muted"> · meetings are detected automatically</span>}
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
