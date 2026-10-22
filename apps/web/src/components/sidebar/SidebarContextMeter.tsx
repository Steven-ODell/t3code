import { GaugeIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { type ContextFill, formatContextFillPercent } from "./sidebarContextUsage";

const LEVEL_COLOR: Record<ContextFill["level"], string> = {
  normal: "var(--color-ring)",
  high: "var(--color-warning)",
  full: "var(--color-error)",
};

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** A thread's context fill as a small ring and percent, for a sidebar card. */
export function SidebarContextRing({ fill }: { readonly fill: ContextFill }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 tabular-nums",
        fill.level === "normal" ? "text-muted-foreground/70" : "font-medium",
      )}
      style={fill.level === "normal" ? undefined : { color: LEVEL_COLOR[fill.level] }}
    >
      <svg viewBox="0 0 24 24" className="size-3 -rotate-90" aria-hidden>
        <circle
          cx="12"
          cy="12"
          r={RADIUS}
          fill="none"
          className="stroke-muted-foreground/25"
          strokeWidth="4"
        />
        <circle
          cx="12"
          cy="12"
          r={RADIUS}
          fill="none"
          stroke={LEVEL_COLOR[fill.level]}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - fill.percent / 100)}
        />
      </svg>
      {formatContextFillPercent(fill.percent)}
    </span>
  );
}

/** The hover card's context line: tokens used of the window. */
export function SidebarContextLine({ fill }: { readonly fill: ContextFill }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <GaugeIcon className="size-3 shrink-0 stroke-muted-foreground" />
      <div className="min-w-0 truncate text-foreground/75">
        Context {formatContextFillPercent(fill.percent)} full · {fill.tokensLabel} tokens
      </div>
    </div>
  );
}
