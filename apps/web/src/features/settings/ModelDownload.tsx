import type { ModelEngine, ModelState } from "@meeting-recorder/shared";
import { CircleCheck, Download, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

const SIZE: Record<ModelEngine, string> = { whisper: "632 MB", qwen: "1.8 GB" };

/** Download status of one open model: a Download button, a progress bar, or "ready". */
export function ModelDownload({ engine, state, onDownload }: { engine: ModelEngine; state?: ModelState; onDownload: () => void }) {
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
        <p className="text-xs text-muted-foreground">You can close this window: it keeps going in the background.</p>
      </div>
    );
  }
  return (
    <div className="grid gap-2 rounded-lg bg-muted/60 p-3">
      {state.state === "failed"
        ? <p className="text-sm text-destructive" role="alert">{state.error ?? "The download didn't finish."}</p>
        : <p className="text-sm text-muted-foreground">Not downloaded yet. If you don't download it now, it downloads before the first meeting that needs it.</p>}
      <Button variant="outline" size="sm" className="w-fit" onClick={onDownload}>
        {state.state === "failed" ? <RotateCw /> : <Download />}
        {state.state === "failed" ? "Try again" : `Download now (${SIZE[engine]})`}
      </Button>
    </div>
  );
}
