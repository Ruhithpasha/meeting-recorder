import { useEffect, useState } from "react";
import type { Meeting, Transcript } from "@meeting-recorder/shared";
import { api } from "../../api/client.ts";
import { formatDuration } from "../../components/format.ts";
import { Button } from "../../components/ui.tsx";

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
      ? <p className="muted" role="status">{error ?? "Loading transcript…"}</p>
      : transcript.segments.length === 0
        ? <p className="muted">No speech was found in this recording.</p>
        : (
          <ol className="transcript" aria-label="Transcript">
            {transcript.segments.map((s, i) => (
              <li key={i}>
                <button type="button" className="segment" onClick={() => onSeek(s.start)} title="Play from here">
                  <span className="segment-time">{formatDuration(s.start)}</span>
                  <span className={`segment-speaker speaker-${s.speaker === "You" ? "you" : "others"}`}>{s.speaker}</span>
                  <span className="segment-text">{s.text}</span>
                </button>
              </li>
            ))}
          </ol>
        );
  } else if (meeting.transcript === "running") body = <p className="muted" role="status">Transcribing on this Mac…</p>;
  else if (meeting.transcript === "failed") {
    body = (
      <div className="field-row">
        <p className="error-text" role="alert">{error ?? "Transcription failed."}</p>
        <Button disabled={retrying} onClick={retry}>{retrying ? "Queuing…" : "Retry"}</Button>
      </div>
    );
  } else {
    body = (
      <p className="muted">
        The transcript is made on this Mac when it's idle and plugged in.{" "}
        <Button disabled={retrying} onClick={retry}>{retrying ? "Queuing…" : "Transcribe now"}</Button>
        {error && <span className="error-text" role="alert"> {error}</span>}
      </p>
    );
  }

  if (!body) return null;
  return (
    <section className="transcript-panel" aria-label="Transcript section">
      <h3>Transcript</h3>
      {body}
    </section>
  );
}
