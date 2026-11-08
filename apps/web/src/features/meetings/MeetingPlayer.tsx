import { useRef, useState } from "react";
import type { Meeting } from "@meeting-recorder/shared";
import { api } from "../../api/client.ts";
import { formatBytes, formatDateTime, formatDuration } from "../../components/format.ts";
import { Button, EmptyState } from "../../components/ui.tsx";
import { TranscriptPanel } from "./TranscriptPanel.tsx";

/** Plays a meeting (streamed with Range requests, so seeking works) and deletes it to the Trash. */
export function MeetingPlayer({ meeting, onDeleted }: { meeting: Meeting | null; onDeleted: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  if (!meeting) return <EmptyState title="Select a meeting">Pick a recording on the left to play it.</EmptyState>;

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteMeeting(meeting.id);
      onDeleted(meeting.id);
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };

  const recording = meeting.status === "recording";
  return (
    <article className="player" aria-label={`Meeting: ${meeting.title}`}>
      <h2>{meeting.title}</h2>
      <p className="muted">
        {meeting.app} · {formatDateTime(meeting.startedAt)} · {formatDuration(meeting.durationSec)} · {formatBytes(meeting.sizeBytes)}
      </p>
      {meeting.status === "recovered" && (
        <p className="note">This recording was interrupted and recovered up to the last saved few seconds.</p>
      )}
      {recording ? (
        <div className="video-placeholder">Recording in progress. It can be played once it's saved.</div>
      ) : videoError ? (
        <div className="video-placeholder" role="alert">This file can't be played in the browser. Open it from the Meetings folder instead.</div>
      ) : (
        // key: a fresh element per meeting so the previous one's buffer is released
        <video ref={video} key={meeting.id} className="video" src={api.mediaUrl(meeting.id)} controls preload="metadata" onError={() => setVideoError(true)} />
      )}
      <div className="player-actions">
        {!recording && (
          <Button onClick={() => { api.reveal(meeting.id).catch((e: Error) => setError(e.message)); }}>Show in Finder</Button>
        )}
        {!confirming ? (
          <Button variant="danger" disabled={recording} onClick={() => setConfirming(true)}>Delete…</Button>
        ) : (
          <>
            <span>Move this recording to the Trash?</span>
            <Button variant="danger" disabled={deleting} onClick={remove}>{deleting ? "Deleting…" : "Move to Trash"}</Button>
            <Button disabled={deleting} onClick={() => setConfirming(false)}>Cancel</Button>
          </>
        )}
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <TranscriptPanel meeting={meeting} onSeek={(s) => {
        if (!video.current) return;
        video.current.currentTime = s;
        void video.current.play().catch(() => {});
      }} />
    </article>
  );
}
