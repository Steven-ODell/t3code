import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import { elapsedShare, providersWithLimits } from "@t3tools/shared/usageLimits";

export interface SidebarLimitWindow {
  readonly id: string;
  /** "5h", "7d", or the provider's own label when the duration is unknown or shared. */
  readonly shortLabel: string;
  readonly window: ServerProviderUsageWindow;
  readonly usedPercent: number;
  /** How far into the window the clock is, 0-100; null without a reset time. */
  readonly elapsedPercent: number | null;
  /**
   * Points under even pace: positive means headroom, negative means spending
   * faster than the window elapses. Null when the elapsed share is unknown.
   */
  readonly paceGap: number | null;
}

export interface SidebarLimitProvider {
  readonly instanceId: string;
  readonly driver: ServerProvider["driver"];
  readonly windows: ReadonlyArray<SidebarLimitWindow>;
}

function durationLabel(minutes: number | undefined): string | null {
  if (minutes === undefined || minutes <= 0) return null;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * The subscription windows to show in the sidebar footer, per provider that
 * reports any. Windows keep the provider's order; a duration two windows share
 * (Claude's weekly and weekly-Opus) falls back to the provider's labels.
 */
export function sidebarLimitProviders(
  providers: ReadonlyArray<ServerProvider>,
  now: number,
): ReadonlyArray<SidebarLimitProvider> {
  return providersWithLimits(providers).flatMap((provider) => {
    const windows = provider.usageLimits?.windows ?? [];
    if (windows.length === 0) return [];
    const durations = windows.map((window) => durationLabel(window.windowDurationMins));
    return [
      {
        instanceId: String(provider.instanceId),
        driver: provider.driver,
        windows: windows.map((window, index) => {
          const duration = durations[index] ?? null;
          const unique =
            duration !== null && durations.indexOf(duration) === durations.lastIndexOf(duration);
          const elapsed = elapsedShare(window, now);
          const usedPercent = Math.round(window.usedPercent);
          const elapsedPercent = elapsed === null ? null : Math.round(elapsed * 100);
          return {
            id: window.id,
            shortLabel: unique ? duration : window.label,
            window,
            usedPercent,
            elapsedPercent,
            paceGap: elapsedPercent === null ? null : elapsedPercent - usedPercent,
          };
        }),
      },
    ];
  });
}
