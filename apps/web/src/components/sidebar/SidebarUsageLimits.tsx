import { useAtomValue } from "@effect/atom-react";
import { formatResetsIn } from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";
import { memo, useMemo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { primaryServerProvidersAtom } from "../../state/server";
import { providerClients } from "../settings/providerDriverMeta";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { type SidebarLimitWindow, sidebarLimitProviders } from "./sidebarUsageLimits";

/** Pace gap as the usage-line mod writes it: "15+" under even pace, "6-" over. */
function PaceGap({ gap }: { readonly gap: number | null }) {
  if (gap === null) return <span />;
  return (
    <span
      className={cn(
        "text-right tabular-nums",
        gap >= 0 ? "text-diff-addition-foreground" : "text-error-foreground",
      )}
    >
      {Math.abs(gap)}
      {gap >= 0 ? "+" : "-"}
    </span>
  );
}

function LimitRow({ limit, now }: { readonly limit: SidebarLimitWindow; readonly now: number }) {
  const resetsIn = formatResetsIn(limit.window, now);
  const high = limit.usedPercent >= 90;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="img"
            aria-label={`${limit.window.label}: ${limit.usedPercent}% used`}
            className="grid grid-cols-[1.75rem_2rem_minmax(0,1fr)_2.25rem] items-center gap-x-2"
          />
        }
      >
        <PaceGap gap={limit.paceGap} />
        <span className="truncate text-sidebar-muted-foreground">{limit.shortLabel}</span>
        <span className="relative h-1.5 self-center rounded-full bg-muted">
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${limit.usedPercent}%`,
              backgroundColor: high ? "var(--color-error)" : "var(--color-ring)",
            }}
          />
          {limit.elapsedPercent !== null ? (
            <span
              aria-hidden
              className="absolute -inset-y-0.5 w-px -translate-x-1/2 bg-foreground/70"
              style={{ left: `${limit.elapsedPercent}%` }}
            />
          ) : null}
        </span>
        <span
          className={cn(
            "text-right tabular-nums",
            high ? "font-medium text-error-foreground" : "text-sidebar-foreground",
          )}
        >
          {limit.usedPercent}%
        </span>
      </TooltipTrigger>
      <TooltipPopup side="right">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {limit.window.label}: {limit.usedPercent}% used
          </span>
          {limit.paceGap !== null ? (
            <span className="text-muted-foreground">
              {limit.paceGap >= 0
                ? `${limit.paceGap} points under even pace`
                : `${-limit.paceGap} points over even pace`}
              . The line is where even spending would be.
            </span>
          ) : null}
          {resetsIn ? <span className="text-muted-foreground">{resetsIn}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Subscription windows (Claude's 5h and 7d, Codex's) in the sidebar footer,
 * from the primary environment's provider snapshots, in the theme's accent
 * rather than provider brand colors. Repaints once a minute for the pace
 * line; clicking opens Usage.
 */
export const SidebarUsageLimits = memo(function SidebarUsageLimits() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const nowMinute = useNowMinute();
  const navigate = useNavigate();
  // The minute is a UTC ISO prefix ("2026-10-22T07:47"); without the zone it would parse as local.
  const now = Date.parse(`${nowMinute}:00Z`);
  const limitProviders = useMemo(() => sidebarLimitProviders(providers, now), [providers, now]);
  if (limitProviders.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => void navigate({ to: "/usage" })}
      aria-label="Open usage"
      className="flex w-full cursor-pointer flex-col gap-1.5 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {limitProviders.map((provider) => (
        <div key={provider.instanceId} className="flex flex-col gap-0.5">
          {limitProviders.length > 1 ? (
            <span className="text-sidebar-muted-foreground">
              {providerClients.get(provider.driver)?.label ?? provider.driver}
            </span>
          ) : null}
          {provider.windows.map((limit) => (
            <LimitRow key={limit.id} limit={limit} now={now} />
          ))}
        </div>
      ))}
    </button>
  );
});
