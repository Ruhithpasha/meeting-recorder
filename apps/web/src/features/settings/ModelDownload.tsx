import type { ModelEngine, ModelState } from "@meeting-recorder/shared";
import { CircleCheck, Download, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

const SIZE: Record<ModelEngine, string> = { whisper: "632 MB", qwen: "1.8 GB" };

/** Download status of one open model: a Download button, a progress bar, or "ready". */
export function ModelDownload({ engine, state, cancelling, cancelError, onDownload, onCancel }: {
  engine: ModelEngine; state?: ModelState; cancelling?: boolean; cancelError?: string;
  onDownload: () => void; onCancel: () => void;
}) {
  if (!state || state.state === "unavailable") return null;
  if (state.state === "ready") {
    return (
      <p className="flex items-center gap-1.5 text-sm text-primary animate-in fade-in" role="status">
        <CircleCheck className="size-4" />Downloaded and ready
      </p>
    );
  }
  if (state.state === "downloading") {
    const percent = state.percent ?? 0;
    return (
      <div className="grid gap-1.5 rounded-lg bg-muted/60 p-3 animate-in fade-in" role="status" aria-live="polite">
        <div className="flex justify-between text-sm">
          <span>{state.what ?? "Downloading…"}</span>
          <span className="tabular-nums text-muted-foreground">{percent}%</span>
        </div>
        <Progress value={percent} aria-label={`Downloading ${engine}`} />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">You can close this window: it keeps going in the background.</p>
          <Button variant="ghost" size="sm" className="shrink-0 text-destructive hover:text-destructive" disabled={cancelling} onClick={onCancel}>
            <X />{cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        </div>
        {cancelError && <p className="text-xs text-destructive" role="alert">Couldn't cancel: {cancelError}. It's still downloading.</p>}
      </div>
    );
  }
  return (
    <div className="grid gap-2 rounded-lg bg-muted/60 p-3">
      {state.state === "failed"
        ? <p className="text-sm text-destructive" role="alert">{state.error ?? "The download didn't finish."}</p>
        : <p className="text-sm text-muted-foreground">Not downloaded yet. A cancelled download picks up where it stopped.</p>}
      <Button variant="outline" size="sm" className="w-fit" onClick={onDownload}>
        {state.state === "failed" ? <RotateCw /> : <Download />}
        {state.state === "failed" ? "Try again" : `Download now (${SIZE[engine]})`}
      </Button>
    </div>
  );
}
