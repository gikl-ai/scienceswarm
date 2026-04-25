// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRuntimeHosts } from "@/hooks/use-runtime-hosts";

function RuntimeHostsProbe({
  deferInitialRefresh = true,
  refreshImmediately = false,
}: {
  deferInitialRefresh?: boolean;
  refreshImmediately?: boolean;
}) {
  const runtimeHosts = useRuntimeHosts({
    deferInitialRefresh,
    initialRefreshDelayMs: 3_000,
    refreshImmediately,
  });

  return (
    <div>
      <span data-testid="loading">{String(runtimeHosts.loading)}</span>
      <span data-testid="host-count">{runtimeHosts.hosts.length}</span>
    </div>
  );
}

describe("useRuntimeHosts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            checkedAt: "2026-04-25T00:00:00.000Z",
            hosts: [],
          }),
          { status: 200 },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps deferred runtime health in loading state until the first fetch", () => {
    render(<RuntimeHostsProbe deferInitialRefresh />);

    expect(screen.getByTestId("loading")).toHaveTextContent("true");
    expect(fetch).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2_999);
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not reset the periodic poll interval when refreshImmediately toggles", () => {
    const { rerender } = render(<RuntimeHostsProbe deferInitialRefresh />);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender(<RuntimeHostsProbe deferInitialRefresh refreshImmediately />);
    expect(fetch).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    rerender(<RuntimeHostsProbe deferInitialRefresh />);

    act(() => {
      vi.advanceTimersByTime(5_999);
    });
    expect(fetch).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
