import { Settings as SettingsIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ModelEngine, ModelState, ServerEvent, Status } from "@meeting-recorder/shared";
import { establishSession, type SessionResult } from "@/api/session.ts";
import { EmptyState, Spinner } from "@/components/ui.tsx";
import { BrandMark } from "@/components/Waveform.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { MeetingList } from "@/features/meetings/MeetingList.tsx";
import { MeetingPlayer, type ShareProgress } from "@/features/meetings/MeetingPlayer.tsx";
import { RecordingBanner } from "@/features/status/RecordingBanner.tsx";
import { useMeetings } from "@/hooks/useMeetings.ts";
import { useServerEvents } from "@/hooks/useServerEvents.ts";

const SettingsView = lazy(() => import("@/features/settings/SettingsView.tsx"));

export function App() {
  const [session, setSession] = useState<SessionResult | "checking">("checking");

  useEffect(() => {
    establishSession().then(setSession, () => setSession("no-session"));
  }, []);

  if (session === "checking") return <Spinner label="Connecting" />;
  if (session !== "ok") {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <EmptyState title="Open the dashboard from Meeting Recorder">
          Open Meeting Recorder from Spotlight or Finder, or choose Open Dashboard in its menu bar icon. This page only
          works from there, so other websites can't read your recordings.
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
  const [shares, setShares] = useState<Record<string, ShareProgress>>({});
  const [liveModels, setLiveModels] = useState<Partial<Record<ModelEngine, ModelState>>>({});
  const meetings = useMeetings();
  const { applyEvent } = meetings;

  const onEvent = useCallback((event: ServerEvent) => {
    if (event.type === "status") setStatus(event.status);
    else if (event.type === "share") setShares((s) => ({ ...s, [event.id]: event }));
    else if (event.type === "model") {
      const { type: _type, engine, ...state } = event;
      setLiveModels((m) => ({ ...m, [engine]: state }));
    }
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
      <main className="mx-auto max-w-3xl p-6">
        <EmptyState title="This dashboard session has ended">
          Meeting Recorder restarted. Open it again from Spotlight or its menu bar icon.
        </EmptyState>
      </main>
    );
  }

  const selected = meetings.items.find((m) => m.id === selectedId) ?? null;
  const liveMeeting = status?.meetingId ? meetings.items.find((m) => m.id === status.meetingId) ?? null : null;

  const settingsOpen = view === "settings";
  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[minmax(290px,340px)_1fr]">
      <aside className="flex min-h-0 flex-col border-b bg-sidebar text-sidebar-foreground md:border-b-0 md:border-r">
        <header className="px-4 pb-2.5 pt-4">
          <h1 className="flex items-center gap-2 whitespace-nowrap text-base font-bold"><BrandMark className="text-primary" />Meeting Recorder</h1>
        </header>
        <div className="flex-1 overflow-y-auto px-2.5 pb-4">
          <MeetingList state={meetings} selectedId={settingsOpen ? null : selectedId}
            onSelect={(id) => { setSelectedId(id); setView("meetings"); }}
            onRetry={meetings.reload} onLoadMore={meetings.loadMore} />
        </div>
        {/* Settings lives at the bottom of the sidebar, like other Mac apps. */}
        <footer className="border-t border-sidebar-border p-2.5">
          <Button variant="ghost" aria-pressed={settingsOpen} onClick={() => setView(settingsOpen ? "meetings" : "settings")}
            className="w-full justify-start gap-2 aria-pressed:bg-card aria-pressed:shadow-sm aria-pressed:ring-1 aria-pressed:ring-border">
            <SettingsIcon className="transition-transform duration-300 group-aria-pressed/button:rotate-90" />Settings
          </Button>
        </footer>
      </aside>
      <main className="min-w-0 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-4 pb-10 pt-4 md:px-7">
          {connection === "reconnecting" && (
            <Alert className="mb-3 border-0 bg-warn" role="status">
              <AlertDescription className="text-warn-foreground">Lost connection to Meeting Recorder. Reconnecting…</AlertDescription>
            </Alert>
          )}
          <RecordingBanner status={status} meeting={liveMeeting} />
          {settingsOpen ? (
            <Suspense fallback={<Spinner label="Loading settings" />}>
              <SettingsView liveModels={liveModels} />
            </Suspense>
          ) : (
            // key: fresh state per meeting, so a pending delete confirmation can't carry over
            <MeetingPlayer key={selected?.id ?? "none"} meeting={selected} share={selected ? shares[selected.id] : undefined}
              onDeleted={() => setSelectedId(null)} />
          )}
        </div>
      </main>
    </div>
  );
}
