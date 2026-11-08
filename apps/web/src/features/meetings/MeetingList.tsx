import type { Meeting } from "@meeting-recorder/shared";
import { formatDateTime, formatDuration } from "../../components/format.ts";
import { Badge, Button, EmptyState, ErrorState, Spinner } from "../../components/ui.tsx";
import type { MeetingsState } from "../../hooks/meetingsReducer.ts";

interface Props {
  state: MeetingsState;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

export function MeetingList({ state, selectedId, onSelect, onRetry, onLoadMore }: Props) {
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
    <div>
      <ul className="meeting-list" aria-label="Meetings">
        {state.items.map((m) => (
          <MeetingRow key={m.id} meeting={m} selected={m.id === selectedId} onSelect={onSelect} />
        ))}
      </ul>
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
        <span className="meeting-title">{meeting.title}</span>
        <span className="meeting-meta">
          {meeting.app} · {formatDateTime(meeting.startedAt)} · {formatDuration(meeting.durationSec)}
        </span>
        {meeting.status === "recording" && <Badge tone="live">Recording</Badge>}
        {meeting.status === "recovered" && <Badge tone="warn">Recovered</Badge>}
      </button>
    </li>
  );
}
