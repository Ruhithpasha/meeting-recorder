import { useEffect, useMemo, useRef, useState } from "react";
import type { Transcript } from "@meeting-recorder/shared";
import { cn } from "cn";
import { api } from "@/api/client.ts";
import { formatDuration } from "@/components/format.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Segment = Transcript["segments"][number];

/** The transcript of the meeting being recorded, line by line as people speak. After the meeting
 *  it stays until the full transcript replaces it. Opened mid-meeting (or reloaded), it first
 *  loads the lines said so far, then adds new ones as they arrive. */
export function LiveTranscript({ meetingId, recording, segments: arriving }: { meetingId: string; recording: boolean; segments: Segment[] }) {
  const [earlier, setEarlier] = useState<Segment[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.live(meetingId).then((lines) => { if (!cancelled) setEarlier(lines); }, () => {});
    return () => { cancelled = true; };
  }, [meetingId]);
  // Lines may be in both the snapshot and the live stream: keep each once, in time order.
  const segments = useMemo(() => {
    const seen = new Set<string>();
    return [...earlier, ...arriving]
      .filter((s) => { const key = `${s.speaker}|${s.start}|${s.text}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((a, b) => a.start - b.start);
  }, [earlier, arriving]);
  const end = useRef<HTMLLIElement>(null);
  const count = segments.length;
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }); }, [count]);

  return (
    <Card className="mt-6" role="region" aria-label="Live transcript">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-heading text-base">
          <span className={cn("size-2 rounded-full", recording ? "bg-live motion-safe:animate-pulse" : "bg-muted-foreground")} aria-hidden="true" />
          {recording ? "Live transcript" : "Live transcript (the full transcript is on its way)"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {count === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">
            Listening. Lines appear here as people speak, and the transcript is ready when the meeting ends.
          </p>
        ) : (
          <ol className="grid max-h-[52vh] gap-0.5 overflow-y-auto" aria-live="polite">
            {segments.map((s, i) => (
              <li key={i} ref={i === count - 1 ? end : undefined}
                className="grid grid-cols-1 gap-x-2.5 rounded-lg px-2 py-1.5 animate-in fade-in slide-in-from-bottom-1 sm:grid-cols-[3.6em_4.6em_1fr]">
                <span className="tabular-nums text-muted-foreground">{formatDuration(s.start)}</span>
                <span className={cn("font-semibold", s.speaker === "You" && "text-primary")}>{s.speaker}</span>
                <span className="[overflow-wrap:anywhere]">{s.text}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
