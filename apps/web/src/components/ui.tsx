// Small shared building blocks. Each one is used by at least two features.
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({ variant = "secondary", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  return <button type="button" className={`btn btn-${variant}${className ? ` ${className}` : ""}`} {...props} />;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <p className="state-title">{title}</p>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state" role="alert">
      <p className="state-title">Something went wrong</p>
      <p className="muted">{message}</p>
      {onRetry && <Button onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Badge({ tone, children }: { tone: "neutral" | "live" | "warn"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
