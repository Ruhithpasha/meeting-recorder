// Shared loading / empty / error states, built on shadcn/ui. Each one is used by at least two features.
import type { ReactNode } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="grid justify-items-center gap-2 px-4 py-12 text-center text-muted-foreground" role="status" aria-live="polite">
      <Loader2 className="size-5 animate-spin text-primary" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="grid justify-items-center gap-2 px-4 py-12 text-center">
      <p className="font-heading text-base font-semibold">{title}</p>
      {children && <p className="max-w-sm text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="grid justify-items-center gap-2 px-4 py-12 text-center" role="alert">
      <AlertCircle className="size-5 text-destructive" aria-hidden="true" />
      <p className="font-heading text-base font-semibold">Something went wrong</p>
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry && <Button variant="outline" onClick={onRetry}>Try again</Button>}
    </div>
  );
}
