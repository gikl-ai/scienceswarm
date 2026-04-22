import { describe, expect, it } from "vitest";

import {
  getSearchProfileSettings,
  resolveSearchProfile,
  shouldAllowDegradedSearchResults,
} from "@/brain/search-profiles";

describe("search profile resolution", () => {
  it("defaults normal lookups to the interactive profile", () => {
    expect(resolveSearchProfile({})).toBe("interactive");
    expect(resolveSearchProfile({ detail: "medium" })).toBe("interactive");
  });

  it("promotes high-detail searches to synthesis unless overridden", () => {
    expect(resolveSearchProfile({ detail: "high" })).toBe("synthesis");
    expect(
      resolveSearchProfile({
        detail: "high",
        profile: "interactive",
      }),
    ).toBe("interactive");
  });

  it("gives synthesis a longer timeout budget and disables degraded fallbacks by default", () => {
    const interactive = getSearchProfileSettings({ profile: "interactive" });
    const synthesis = getSearchProfileSettings({ profile: "synthesis" });

    expect(synthesis.storeTimeoutMs).toBeGreaterThan(interactive.storeTimeoutMs);
    expect(synthesis.searchTimeoutMs).toBeGreaterThan(interactive.searchTimeoutMs);
    expect(shouldAllowDegradedSearchResults({ profile: "interactive" })).toBe(true);
    expect(shouldAllowDegradedSearchResults({ profile: "synthesis" })).toBe(false);
    expect(
      shouldAllowDegradedSearchResults({
        profile: "synthesis",
        allowDegradedResults: true,
      }),
    ).toBe(true);
  });
});
