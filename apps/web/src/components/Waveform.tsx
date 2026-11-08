import { cn } from "cn";

/** The brand mark (static) and the banner's live waveform (animated while recording). */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className={className}>
      {[[3, 8], [7, 12], [11, 18], [15, 12], [19, 8]].map(([x, h]) => (
        <rect key={x} x={x! - 1.4} y={11 - h! / 2} width="2.8" height={h} rx="1.4" fill="currentColor" />
      ))}
    </svg>
  );
}

// Staggered delays so the bars move like speech, not in lockstep.
const DELAYS = ["[animation-delay:-0.9s]", "[animation-delay:-0.3s]", "[animation-delay:-0.6s]", "[animation-delay:-0.1s]", "[animation-delay:-0.75s]"];

export function LiveWave({ live }: { live: boolean }) {
  return (
    <span className={cn("flex h-7 w-8 shrink-0 items-center gap-[3px]", live ? "text-live" : "text-muted-foreground/60")} aria-hidden="true">
      {DELAYS.map((delay) => (
        <span key={delay}
          className={cn(delay, "h-[22%] flex-1 rounded-full bg-current transition-[height] duration-500",
            live && "animate-wave motion-reduce:h-3/5 motion-reduce:animate-none")} />
      ))}
    </span>
  );
}
