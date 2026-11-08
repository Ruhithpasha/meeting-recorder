import { useCallback, useEffect, useReducer } from "react";
import type { ServerEvent } from "@meeting-recorder/shared";
import { api } from "../api/client.ts";
import { initialMeetings, meetingsReducer } from "./meetingsReducer.ts";

const PAGE_SIZE = 50;

export function useMeetings() {
  const [state, dispatch] = useReducer(meetingsReducer, initialMeetings);

  const load = useCallback(async () => {
    dispatch({ type: "loadStart" });
    try {
      dispatch({ type: "pageLoaded", page: await api.listMeetings(undefined, PAGE_SIZE), append: false });
    } catch (error) {
      dispatch({ type: "loadFailed", error: (error as Error).message });
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!state.nextCursor || state.loadingMore) return;
    dispatch({ type: "loadMoreStart" });
    try {
      dispatch({ type: "pageLoaded", page: await api.listMeetings(state.nextCursor, PAGE_SIZE), append: true });
    } catch (error) {
      dispatch({ type: "loadFailed", error: (error as Error).message });
    }
  }, [state.nextCursor, state.loadingMore]);

  const applyEvent = useCallback((event: ServerEvent) => dispatch({ type: "event", event }), []);

  useEffect(() => { void load(); }, [load]);

  return { ...state, reload: load, loadMore, applyEvent };
}
