import { useEffect, useState } from "react";
import type { Meeting, Status } from "@meeting-recorder/shared";
import { Circle, Square } from "lucide-react";
import { cn } from "cn";
import { api } from "@/api/client.ts";
import { formatDuration } from "@/components/format.ts";
import { LiveWave } from "@/components/Waveform.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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

  if (!status) {
    return <div className="mb-5 rounded-2xl border bg-card px-4 py-3 text-sm text-muted-foreground" aria-busy="true">Connecting to the recorder…</div>;
  }

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

  return (
    <section aria-label="Recorder status"
      className={cn("mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border bg-card px-4 py-3 shadow-sm transition-colors duration-300",
        live && "border-live/40 bg-live-soft")}>
      <div className="flex min-w-56 flex-1 items-center gap-3" role="status" aria-live="polite">
        <LiveWave live={live} />
        <div className="grid leading-tight">
          <span className="font-semibold">{LABEL[status.state]}{live && meeting ? `: ${meeting.app}` : ""}</span>
          <span className="text-sm text-muted-foreground">
            {status.state === "idle" && status.agentConnected && "Ready to record"}
            {live && "Your screen and both sides of the audio"}
            {status.state === "stopping" && "Finishing the file"}
            {!status.agentConnected && "Meeting Recorder isn't connected"}
          </span>
        </div>
        {elapsed && (
          <span className="font-heading text-xl font-semibold tabular-nums text-live animate-in fade-in" aria-label={`Recording for ${elapsed}`}>{elapsed}</span>
        )}
      </div>
      {status.state === "idle" && (
        <Button disabled={busy || !status.agentConnected} onClick={() => act(api.startRecording)}>
          <Circle className="fill-current" />Start recording
        </Button>
      )}
      {status.state === "recording" && status.meetingId && (
        <Button className="bg-live text-white hover:bg-live/85" disabled={busy} onClick={() => act(() => api.stopRecording(status.meetingId!))}>
          <Square className="fill-current" />Stop
        </Button>
      )}
      {(status.warning || error) && (
        <Alert className="basis-full border-0 bg-warn text-warn-foreground" role="alert">
          <AlertDescription className="text-warn-foreground">{error ?? status.warning}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}
