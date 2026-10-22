import { describe, expect, it } from "vite-plus/test";

import { contextFillOf, formatContextFillPercent } from "./sidebarContextUsage";

describe("contextFillOf", () => {
  it("reports percent, level and tokens against the window", () => {
    expect(contextFillOf({ usedTokens: 430_000, maxTokens: 1_000_000 })).toEqual({
      percent: 43,
      level: "normal",
      tokensLabel: "430k / 1M",
    });
    expect(contextFillOf({ usedTokens: 150_000, maxTokens: 200_000 })?.level).toBe("high");
    expect(contextFillOf({ usedTokens: 190_000, maxTokens: 200_000 })?.level).toBe("full");
  });

  it("has nothing to show without a window size", () => {
    expect(contextFillOf({ usedTokens: 40_000 })).toBeNull();
    expect(contextFillOf(null)).toBeNull();
  });

  it("never rounds a non-empty context down to 0%", () => {
    expect(formatContextFillPercent(0.4)).toBe("<1%");
    expect(formatContextFillPercent(0)).toBe("0%");
    expect(formatContextFillPercent(42.6)).toBe("43%");
  });
});
