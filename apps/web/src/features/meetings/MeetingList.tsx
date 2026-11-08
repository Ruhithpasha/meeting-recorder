import { useEffect, useMemo, useState } from "react";
import type { Meeting } from "@meeting-recorder/shared";
import { dayLabel, formatDuration, formatTime } from "../../components/format.ts";
import { Badge, Button, EmptyState, ErrorState, Spinner } from "../../components/ui.tsx";
import type { MeetingsState } from "../../hooks/meetingsReducer.ts";

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
    <div className="meeting-list-panel" role="region" aria-label="Meetings">
      <input className="search" type="search" placeholder="Search meetings" aria-label="Search meetings"
        value={query} onChange={(e) => setQuery(e.target.value)} />
      {groups.length === 0 && (
        <p className="muted state-inline">
          No {state.nextCursor ? "loaded " : ""}meetings match “{query}”.
          {state.nextCursor && " Search covers the meetings loaded so far: load older meetings to search further."}
        </p>
      )}
      {groups.map(([day, meetings]) => (
        <section key={day}>
          <h2 className="day-label">{day}</h2>
          <ul className="meeting-list" aria-label={day}>
            {meetings.map((m) => <MeetingRow key={m.id} meeting={m} selected={m.id === selectedId} onSelect={onSelect} />)}
          </ul>
        </section>
      ))}
      {state.error && <p className="error-text" role="alert">{state.error}</p>}
      {state.nextCursor && (
        <Button className="load-more" disabled={state.loadingMore} onClick={onLoadMore}>
          {state.loadingMore ? "Loading…" : "Load older meetings"}
        </Button>
      )}
    </div>
  );
}

function MeetingRow({ meeting, selected, onSelect }: { meeting: Meeting; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" className={`meeting-row${selected ? " selected" : ""}`} aria-current={selected || undefined} onClick={() => onSelect(meeting.id)}>
        <span className="app-dot" aria-hidden="true">{meeting.app.slice(0, 1).toUpperCase()}</span>
        <span className="meeting-main">
          <span className="meeting-title">{meeting.title}</span>
          <span className="meeting-meta">
            {formatTime(meeting.startedAt)} · {meeting.app}{meeting.durationSec !== null ? ` · ${formatDuration(meeting.durationSec)}` : ""}
          </span>
        </span>
        <span className="meeting-badges">
          {meeting.status === "recording" && <Badge tone="live">Recording</Badge>}
          {meeting.status === "recovered" && <Badge tone="warn">Recovered</Badge>}
          {meeting.transcript === "done" && <Badge tone="neutral">Transcript</Badge>}
        </span>
      </button>
    </li>
  );
}
