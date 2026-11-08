// Meeting list state: cursor pages from the API plus live updates from SSE, in one pure reducer.
import type { Meeting, MeetingPage, ServerEvent } from "@meeting-recorder/shared";

export interface MeetingsState {
  items: Meeting[];          // newest first (ids sort chronologically)
  nextCursor: string | null;
  phase: "loading" | "ready" | "error";
  loadingMore: boolean;
  error: string | null;
  /** True while a first-page (re)load is in flight; live events are buffered and replayed after it. */
  refreshing: boolean;
  buffered: ServerEvent[];
}

export type MeetingsAction =
  | { type: "loadStart" }
  | { type: "loadMoreStart" }
  | { type: "pageLoaded"; page: MeetingPage; append: boolean }
  | { type: "loadFailed"; error: string }
  | { type: "event"; event: ServerEvent };

export const initialMeetings: MeetingsState = {
  items: [], nextCursor: null, phase: "loading", loadingMore: false, error: null, refreshing: true, buffered: [],
};

export function meetingsReducer(state: MeetingsState, action: MeetingsAction): MeetingsState {
  switch (action.type) {
    case "loadStart":
      // Keep showing the current list during a resync; only show the spinner when there's nothing.
      return { ...state, phase: state.items.length ? state.phase : "loading", error: null, refreshing: true, buffered: [] };
    case "loadMoreStart":
      return { ...state, loadingMore: true, error: null };
    case "pageLoaded": {
      if (action.append) {
        return { ...state, items: mergeById(state.items, action.page.items), nextCursor: action.page.nextCursor, loadingMore: false, error: null };
      }
      // The snapshot may predate events that arrived while it loaded: replay them on top.
      const fresh: MeetingsState = { ...state, items: action.page.items, nextCursor: action.page.nextCursor, phase: "ready", error: null, refreshing: false, buffered: [] };
      return state.buffered.reduce(applyEvent, fresh);
    }
    case "loadFailed":
      return { ...state, phase: state.items.length ? "ready" : "error", loadingMore: false, error: action.error, refreshing: false, buffered: [] };
    case "event": {
      const next = applyEvent(state, action.event);
      return state.refreshing ? { ...next, buffered: [...state.buffered, action.event] } : next;
    }
  }
}

function applyEvent(state: MeetingsState, event: ServerEvent): MeetingsState {
  if (event.type === "meetingDeleted") return { ...state, items: state.items.filter((m) => m.id !== event.id) };
  if (event.type !== "meeting") return state;
  const { meeting } = event;
  const index = state.items.findIndex((m) => m.id === meeting.id);
  if (index >= 0) {
    const items = state.items.slice();
    items[index] = meeting;
    return { ...state, items };
  }
  // A meeting older than the last loaded one belongs to a page we haven't fetched yet.
  const oldest = state.items.at(-1)?.id;
  if (state.nextCursor && oldest && meeting.id < oldest) return state;
  return { ...state, items: insertSorted(state.items, meeting) };
}

const insertSorted = (items: Meeting[], meeting: Meeting) => {
  const i = items.findIndex((m) => m.id < meeting.id);
  return i < 0 ? [...items, meeting] : [...items.slice(0, i), meeting, ...items.slice(i)];
};

const mergeById = (existing: Meeting[], incoming: Meeting[]) => {
  const seen = new Set(existing.map((m) => m.id));
  return [...existing, ...incoming.filter((m) => !seen.has(m.id))];
};
