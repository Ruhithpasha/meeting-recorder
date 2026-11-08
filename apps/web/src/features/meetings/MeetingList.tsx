import { useEffect, useMemo, useState } from "react";
import type { Meeting } from "@meeting-recorder/shared";
import { Search } from "lucide-react";
import { cn } from "cn";
import { dayLabel, formatDuration, formatTime } from "@/components/format.ts";
import { EmptyState, ErrorState, Spinner } from "@/components/ui.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MeetingsState } from "@/hooks/meetingsReducer.ts";

interface Props {
  state: MeetingsState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

/** Re-renders at local midnight so "Today" / "Yesterday" never go stale in an open window. */
function useToday(): string {
  const key = () => new Date().toDateString();
  const [today, setToday] = useState(key);
  useEffect(() => {
    const timer = setInterval(() => setToday(key()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return today;
}

/** Meetings grouped by day (newest first) with a quick search over title and app. */
export function MeetingList({ state, selectedId, onSelect, onRetry, onLoadMore }: Props) {
  const [query, setQuery] = useState("");
  const today = useToday();
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q ? state.items.filter((m) => `${m.title} ${m.app}`.toLowerCase().includes(q)) : state.items;
    const byDay = new Map<string, Meeting[]>();
    for (const m of matches) {
      const label = dayLabel(m.startedAt, new Date(today));
      const group = byDay.get(label);
      if (group) group.push(m);
      else byDay.set(label, [m]);
    }
    return [...byDay.entries()];
  }, [state.items, query, today]);

  if (state.phase === "loading") return <Spinner label="Loading meetings" />;
  if (state.phase === "error") return <ErrorState message={state.error ?? "Couldn't load meetings."} onRetry={onRetry} />;
  if (!state.items.length) {
    return (
      <EmptyState title="No recordings yet">
        Join a Zoom, Teams or Google Meet call and it will be recorded automatically, or press Start recording.
      </EmptyState>
    );
  }
  return (
    <div role="region" aria-label="Meetings">
      <div className="relative mb-1.5 mt-0.5">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input type="search" placeholder="Search meetings" aria-label="Search meetings" className="bg-card pl-8"
          value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {groups.length === 0 && (
        <p className="px-1.5 py-2.5 text-sm text-muted-foreground">
          No {state.nextCursor ? "loaded " : ""}meetings match “{query}”.
          {state.nextCursor && " Search covers the meetings loaded so far: load older meetings to search further."}
        </p>
      )}
      {groups.map(([day, meetings]) => (
        <section key={day}>
          <h2 className="mx-1.5 mb-1 mt-4 text-xs font-semibold text-muted-foreground">{day}</h2>
          <ul className="grid gap-0.5" aria-label={day}>
            {meetings.map((m) => <MeetingRow key={m.id} meeting={m} selected={m.id === selectedId} onSelect={onSelect} />)}
          </ul>
        </section>
      ))}
      {state.error && <p className="mt-2 text-sm text-destructive" role="alert">{state.error}</p>}
      {state.nextCursor && (
        <Button variant="outline" className="mt-3 w-full" disabled={state.loadingMore} onClick={onLoadMore}>
          {state.loadingMore ? "Loading…" : "Load older meetings"}
        </Button>
      )}
    </div>
  );
}

function MeetingRow({ meeting, selected, onSelect }: { meeting: Meeting; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" aria-current={selected || undefined} onClick={() => onSelect(meeting.id)}
        className={cn("grid w-full grid-cols-[1fr_auto] gap-x-2.5 gap-y-0.5 rounded-xl px-2.5 py-2 text-left transition-all duration-150",
          "hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring",
          selected && "bg-card shadow-sm ring-1 ring-border hover:bg-card")}>
        <span className="truncate font-semibold">{meeting.title}</span>
        <span className="self-center text-sm tabular-nums text-muted-foreground">
          {meeting.durationSec !== null ? formatDuration(meeting.durationSec) : ""}
        </span>
        <span className="col-span-full flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="secondary" className="bg-accent text-accent-foreground">{meeting.app}</Badge>
          <span className="tabular-nums">{formatTime(meeting.startedAt)}</span>
          {meeting.status === "recording" && <Badge className="animate-pulse bg-live text-white">Recording</Badge>}
          {meeting.status === "recovered" && <Badge className="bg-warn text-warn-foreground">Recovered</Badge>}
          {meeting.summary === "done"
            ? <Badge variant="outline">Summary</Badge>
            : meeting.transcript === "done" && <Badge variant="outline">Transcript</Badge>}
        </span>
      </button>
    </li>
  );
}
