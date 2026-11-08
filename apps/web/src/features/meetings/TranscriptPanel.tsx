import { useEffect, useState } from "react";
import type { Meeting, Transcript } from "@meeting-recorder/shared";
import { cn } from "cn";
import { api } from "@/api/client.ts";
import { formatDuration } from "@/components/format.ts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The meeting's transcript, made on this Mac. "You" is your microphone, "Others" is everyone else
 * (separate audio tracks, so no guessing). Click a line to jump the video there.
 */
export function TranscriptPanel({ meeting, onSeek }: { meeting: Meeting; onSeek: (seconds: number) => void }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (meeting.transcript !== "done") return;
    let cancelled = false;
    setError(null);
    api.getTranscript(meeting.id).then(
      (t) => { if (!cancelled) setTranscript(t); },
      (e: Error) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, [meeting.id, meeting.transcript]);

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      await api.transcribe(meeting.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRetrying(false);
    }
  };

  let body;
  if (meeting.status === "recording") body = null;
  else if (meeting.transcript === "done") {
    body = !transcript
      ? <p className="text-sm text-muted-foreground" role="status">{error ?? "Loading transcript…"}</p>
      : transcript.segments.length === 0
        ? <p className="text-sm text-muted-foreground">No speech was found in this recording.</p>
        : (
          <ol className="grid max-h-[52vh] gap-0.5 overflow-y-auto animate-in fade-in duration-300" aria-label="Transcript">
            {transcript.segments.map((s, i) => (
              <li key={i}>
                <button type="button" onClick={() => onSeek(s.start)} title="Play from here"
                  className="grid w-full grid-cols-1 gap-x-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-primary/10 sm:grid-cols-[3.6em_4.6em_1fr]">
                  <span className="tabular-nums text-muted-foreground">{formatDuration(s.start)}</span>
                  <span className={cn("font-semibold", s.speaker === "You" && "text-primary")}>{s.speaker}</span>
                  <span className="[overflow-wrap:anywhere]">{s.text}</span>
                </button>
              </li>
            ))}
          </ol>
        );
  } else if (meeting.transcript === "running") body = <p className="animate-pulse text-sm text-muted-foreground" role="status">Transcribing on this Mac…</p>;
  else if (meeting.transcript === "failed") {
    body = (
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="text-sm text-destructive" role="alert">{error ?? meeting.transcriptError ?? "Transcription failed."}</p>
        <Button variant="outline" size="sm" disabled={retrying} onClick={retry}>{retrying ? "Queuing…" : "Retry"}</Button>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-2.5 text-sm text-muted-foreground">
        <p>The transcript is made on this Mac when it's idle and plugged in.</p>
        <Button variant="outline" size="sm" disabled={retrying} onClick={retry}>{retrying ? "Queuing…" : "Transcribe now"}</Button>
        {error && <span className="text-destructive" role="alert">{error}</span>}
      </div>
    );
  }

  if (!body) return null;
  return (
    <Card className="mt-6" aria-label="Transcript section" role="region">
      <CardHeader><CardTitle className="font-heading text-base">Transcript</CardTitle></CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
