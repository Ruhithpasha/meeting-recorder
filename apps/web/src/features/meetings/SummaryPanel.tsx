import { useEffect, useState } from "react";
import type { Meeting, MeetingSummary } from "@meeting-recorder/shared";
import { Check, Copy, Sparkles } from "lucide-react";
import { api } from "@/api/client.ts";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const SECTIONS: { key: "keyPoints" | "decisions" | "actionItems"; title: string }[] = [
  { key: "keyPoints", title: "Key points" },
  { key: "decisions", title: "Decisions" },
  { key: "actionItems", title: "Action items" },
];

/** This meeting's own on-device summary: overview, key points, decisions, action items. */
export function SummaryPanel({ meeting }: { meeting: Meeting }) {
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (meeting.summary !== "done") return;
    let cancelled = false;
    setError(null);
    api.getSummary(meeting.id).then(
      (s) => { if (!cancelled) setSummary(s); },
      (e: Error) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, [meeting.id, meeting.summary]);

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.summarize(meeting.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!summary) return;
    try {
      // The same Markdown that's saved as summary.md next to the recording.
      await navigator.clipboard.writeText(await api.getSummaryMarkdown(meeting.id));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy to the clipboard.");
    }
  };

  // Nothing to show until there's a transcript to summarize.
  if (meeting.status === "recording" || meeting.transcript !== "done") return null;

  let body;
  if (meeting.summary === "done") {
    body = !summary ? <p className="text-sm text-muted-foreground" role="status">{error ?? "Loading summary…"}</p> : (
      <div className="animate-in fade-in duration-300">
        <p className="mb-1.5 text-[1.02rem]">{summary.overview}</p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-6 gap-y-1">
          {SECTIONS.filter(({ key }) => summary[key].length).map(({ key, title }) => (
            <div key={key}>
              <h4 className="mb-1 mt-3 text-sm font-semibold text-muted-foreground">{title}</h4>
              <ul className="grid list-disc gap-1 pl-4.5 marker:text-primary">
                {summary[key].map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-3.5 text-xs text-muted-foreground">Made on this Mac by Apple's on-device model. Check important details against the recording.</p>
      </div>
    );
  } else if (meeting.summary === "running") {
    body = <p className="animate-pulse text-sm text-muted-foreground" role="status">Writing a summary on this Mac…</p>;
  } else if (meeting.summary === "failed") {
    body = (
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="text-sm text-destructive" role="alert">{error ?? meeting.summaryError ?? "The summary couldn't be written."}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={request}>{busy ? "Queuing…" : "Retry"}</Button>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center gap-2.5 text-sm text-muted-foreground">
        <p>{meeting.summaryError ?? "A summary is written on this Mac when it's idle and plugged in."}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={request}><Sparkles />{busy ? "Queuing…" : "Summarize now"}</Button>
        {error && <span className="text-destructive" role="alert">{error}</span>}
      </div>
    );
  }

  return (
    <Card className="mt-6" aria-label="Summary section" role="region">
      <CardHeader>
        <CardTitle className="font-heading text-base">Summary</CardTitle>
        {summary && meeting.summary === "done" && (
          <CardAction>
            <Button variant="outline" size="sm" onClick={copy}>
              {copied
                ? <span key="done" className="inline-flex items-center gap-1 animate-in zoom-in-50 fade-in duration-200"><Check />Copied</span>
                : <><Copy />Copy</>}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
