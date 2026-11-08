import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ServerEvent, Status } from "@meeting-recorder/shared";
import { establishSession, type SessionResult } from "./api/session.ts";
import { EmptyState, Spinner } from "./components/ui.tsx";
import { MeetingList } from "./features/meetings/MeetingList.tsx";
import { MeetingPlayer } from "./features/meetings/MeetingPlayer.tsx";
import { RecordingBanner } from "./features/status/RecordingBanner.tsx";
import { useMeetings } from "./hooks/useMeetings.ts";
import { useServerEvents } from "./hooks/useServerEvents.ts";

const SettingsView = lazy(() => import("./features/settings/SettingsView.tsx"));

export function App() {
  const [session, setSession] = useState<SessionResult | "checking">("checking");

  useEffect(() => {
    establishSession().then(setSession, () => setSession("no-session"));
  }, []);

  if (session === "checking") return <Spinner label="Connecting" />;
  if (session !== "ok") {
    return (
      <main className="shell">
        <EmptyState title="Open the dashboard from the menu bar">
          Click the Meeting Recorder icon in your menu bar and choose “Open Dashboard”. This page only works
          from that link, so other websites can't read your recordings.
        </EmptyState>
      </main>
    );
  }
  return <Dashboard />;
}

function Dashboard() {
  const [view, setView] = useState<"meetings" | "settings">("meetings");
  const [status, setStatus] = useState<Status | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const meetings = useMeetings();
  const { applyEvent } = meetings;

  const onEvent = useCallback((event: ServerEvent) => {
    if (event.type === "status") setStatus(event.status);
    else applyEvent(event);
  }, [applyEvent]);
  const connection = useServerEvents(onEvent);

  // Events sent while the stream was down are gone: resync the list on every reconnect.
  const everOpen = useRef(false);
  const { reload } = meetings;
  useEffect(() => {
    if (connection !== "open") return;
    if (everOpen.current) void reload();
    everOpen.current = true;
  }, [connection, reload]);

  // Nothing chosen yet: open the newest meeting once, so the player isn't empty. It's a real
  // selection, so a new recording arriving later doesn't yank the player away mid-playback.
  const newestId = meetings.items[0]?.id;
  useEffect(() => {
    if (selectedId === null && newestId) setSelectedId(newestId);
  }, [selectedId, newestId]);

  // (All hooks above this line: the early return below must not change the hook order.)
  if (connection === "closed") {
    return (
      <main className="shell">
        <EmptyState title="This dashboard session has ended">
          The recorder restarted. Click the Meeting Recorder icon in your menu bar and choose “Open Dashboard”.
        </EmptyState>
      </main>
    );
  }

  const selected = meetings.items.find((m) => m.id === selectedId) ?? null;
  const liveMeeting = status?.meetingId ? meetings.items.find((m) => m.id === status.meetingId) ?? null : null;

  return (
    <div className="shell">
      <header className="topbar">
        <h1><span className="logo" aria-hidden="true" />Meeting Recorder</h1>
        <nav aria-label="Sections">
          <button type="button" className={view === "meetings" ? "tab active" : "tab"} aria-current={view === "meetings" ? "page" : undefined} onClick={() => setView("meetings")}>Meetings</button>
          <button type="button" className={view === "settings" ? "tab active" : "tab"} aria-current={view === "settings" ? "page" : undefined} onClick={() => setView("settings")}>Settings</button>
        </nav>
      </header>
      {connection === "reconnecting" && <p className="note" role="status">Lost connection to the recorder. Reconnecting…</p>}
      <RecordingBanner status={status} meeting={liveMeeting} />
      <main>
        {view === "meetings" ? (
          <div className="columns">
            <MeetingList state={meetings} selectedId={selectedId} onSelect={setSelectedId} onRetry={meetings.reload} onLoadMore={meetings.loadMore} />
            {/* key: fresh state per meeting, so a pending delete confirmation can't carry over */}
            <MeetingPlayer key={selected?.id ?? "none"} meeting={selected} onDeleted={() => setSelectedId(null)} />
          </div>
        ) : (
          <Suspense fallback={<Spinner label="Loading settings" />}>
            <SettingsView />
          </Suspense>
        )}
      </main>
    </div>
  );
}
