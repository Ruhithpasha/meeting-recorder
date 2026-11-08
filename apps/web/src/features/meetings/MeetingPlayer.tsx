import { useRef, useState } from "react";
import type { Meeting, ServerEvent, ShareWhat } from "@meeting-recorder/shared";
import { ChevronDown, FileText, Film, FolderOpen, Share, Trash2, Video } from "lucide-react";
import { cn } from "cn";
import { api } from "@/api/client.ts";
import { formatBytes, formatDateTime, formatDuration } from "@/components/format.ts";
import { EmptyState } from "@/components/ui.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SummaryPanel } from "./SummaryPanel.tsx";
import { TranscriptPanel } from "./TranscriptPanel.tsx";

export type ShareProgress = Extract<ServerEvent, { type: "share" }>;

/** Plays a meeting (streamed with Range requests, so seeking works), shares it, deletes it to the Trash. */
export function MeetingPlayer({ meeting, share, onDeleted }: { meeting: Meeting | null; share?: ShareProgress; onDeleted: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState(false);
  const [dismissed, setDismissed] = useState<ShareProgress | undefined>();
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

  const shareAs = (what: ShareWhat) => {
    setError(null);
    setDismissed(share); // a new attempt hides the last copy's failure
    api.share(meeting.id, what).catch((e: Error) => setError(e.message));
  };

  const recording = meeting.status === "recording";
  const copying = share?.state === "exporting";
  const facts: [string, string][] = [
    ["App", meeting.app],
    ["Started", formatDateTime(meeting.startedAt)],
    ["Length", formatDuration(meeting.durationSec)],
    ["Size", formatBytes(meeting.sizeBytes)],
  ];
  const placeholder = "grid min-h-56 place-items-center rounded-2xl border border-dashed bg-card p-6 text-center text-muted-foreground";

  return (
    <article className="animate-in fade-in slide-in-from-bottom-1 duration-300" aria-label={`Meeting: ${meeting.title}`}>
      <h2 className="text-2xl font-bold leading-tight [overflow-wrap:anywhere]">{meeting.title}</h2>
      <dl className="mb-4 mt-2.5 flex flex-wrap gap-x-6 gap-y-1.5">
        {facts.map(([label, value]) => (
          <div key={label} className="grid">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {meeting.status === "recovered" && (
        <Alert className="mb-3 border-0 bg-warn">
          <AlertDescription className="text-warn-foreground">This recording was interrupted and recovered up to the last saved few seconds.</AlertDescription>
        </Alert>
      )}
      {recording ? (
        <div className={placeholder}>Recording in progress. It can be played once it's saved.</div>
      ) : videoError ? (
        <div className={placeholder} role="alert">This file can't be played in the browser. Open it from the Meetings folder instead.</div>
      ) : (
        // key: a fresh element per meeting so the previous one's buffer is released
        <video ref={video} key={meeting.id} className="block max-h-[62vh] w-full rounded-2xl bg-black shadow-md"
          src={api.mediaUrl(meeting.id)} controls preload="metadata" onError={() => setVideoError(true)} />
      )}
      <div className="mb-1 mt-3 flex flex-wrap items-center gap-2">
        {!recording && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button disabled={copying}><Share />{copying ? `Making a smaller copy… ${share?.percent ?? 0}%` : "Share"}<ChevronDown /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Opens the Mac's share menu: AirDrop, Mail, Messages…</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => shareAs("video")}>
                <Video /><div className="grid"><span>Video</span><span className="text-xs text-muted-foreground">Smaller 720p copy, everyone in one audio track</span></div>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => shareAs("original")}>
                <Film /><div className="grid"><span>Original recording</span><span className="text-xs text-muted-foreground">Full quality, {formatBytes(meeting.sizeBytes)}</span></div>
              </DropdownMenuItem>
              {meeting.summary === "done" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => shareAs("summary")}><FileText />Summary</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!recording && (
          <Button variant="outline" onClick={() => { api.reveal(meeting.id).catch((e: Error) => setError(e.message)); }}>
            <FolderOpen />Show in Finder
          </Button>
        )}
        <Button variant="outline" className="text-destructive hover:text-destructive" disabled={recording || confirming} onClick={() => setConfirming(true)}>
          <Trash2 />Delete…
        </Button>
      </div>
      {/* Expands open (grid-rows 0fr -> 1fr) so the confirmation slides in under the button. */}
      <div className={cn("grid transition-[grid-template-rows] duration-200 ease-out", confirming ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          {confirming && (
            <div className="mt-1 flex flex-wrap items-center gap-2 rounded-xl bg-live-soft px-3 py-2.5 text-sm">
              <span>Move this recording to the Trash? You can restore it from the Trash in Finder.</span>
              <Button variant="destructive" disabled={deleting} onClick={remove}>{deleting ? "Deleting…" : "Move to Trash"}</Button>
              <Button variant="ghost" disabled={deleting} onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          )}
        </div>
      </div>
      {copying && (
        <Progress className="mt-2 h-1" value={share?.percent ?? 0} aria-label="Making a smaller copy" />
      )}
      {(error ?? (share?.state === "failed" && share !== dismissed ? share.error : null)) && (
        <p className="mt-2 text-sm text-destructive" role="alert">{error ?? share?.error}</p>
      )}
      <SummaryPanel meeting={meeting} />
      <TranscriptPanel meeting={meeting} onSeek={(s) => {
        if (!video.current) return;
        video.current.currentTime = s;
        void video.current.play().catch(() => {});
      }} />
    </article>
  );
}
