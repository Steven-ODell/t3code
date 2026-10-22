import type { OrchestrationV2ShellContextUsage } from "@t3tools/contracts";

import { formatContextWindowTokens } from "../../lib/contextWindow";

export type ContextFillLevel = "normal" | "high" | "full";

export interface ContextFill {
  readonly percent: number;
  readonly level: ContextFillLevel;
  /** "430k / 1m" */
  readonly tokensLabel: string;
}

/** "430k", "1M": a capital M so a million does not read as minutes. */
function tokens(value: number): string {
  return formatContextWindowTokens(value).replace(/m$/, "M");
}

/**
 * How full a thread's context window is, for the sidebar. Null when the
 * provider never reported a window size, since tokens alone say nothing
 * about how close the thread is to compacting.
 */
export function contextFillOf(
  usage: OrchestrationV2ShellContextUsage | null | undefined,
): ContextFill | null {
  if (usage == null || usage.maxTokens === undefined || usage.maxTokens <= 0) return null;
  const percent = Math.min(100, Math.max(0, (usage.usedTokens / usage.maxTokens) * 100));
  return {
    percent,
    level: percent >= 90 ? "full" : percent >= 70 ? "high" : "normal",
    tokensLabel: `${tokens(usage.usedTokens)} / ${tokens(usage.maxTokens)}`,
  };
}

/** Whole percent, but never "0%" for a context that has something in it. */
export function formatContextFillPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}
