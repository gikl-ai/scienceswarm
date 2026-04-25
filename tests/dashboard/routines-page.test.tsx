// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let searchParamsValue = "name=alpha-project";
const replaceMock = vi.fn();
const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(searchParamsValue),
  useRouter: () => ({
    replace: replaceMock,
    push: pushMock,
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import RoutinesPage from "@/app/dashboard/routines/page";

function buildFetchStub() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "/api/projects") {
      return Response.json({
        projects: [
          { slug: "alpha-project", name: "Alpha Project" },
        ],
      });
    }

    if (url === "/api/scheduler") {
      return Response.json({ jobs: [], pipelines: [] });
    }

    if (url === "/api/brain/dream") {
      return Response.json({ lastRun: null });
    }

    if (url === "/api/brain/dream-schedule") {
      return Response.json({
        enabled: false,
        schedule: "0 3 * * *",
        mode: "full",
        quietHoursStart: 0,
        quietHoursEnd: 6,
        nextRun: null,
      });
    }

    if (url.startsWith("/api/brain/watch-config?project=")) {
      return Response.json({
        config: {
          version: 1,
          keywords: [],
          promotionThreshold: 5,
          stagingThreshold: 2,
          schedule: {
            enabled: false,
            cadence: "daily",
            time: "08:00",
            timezone: "local",
          },
          sources: [],
        },
      });
    }

    if (url === "/api/radar") {
      return Response.json({ error: "No radar configured" }, { status: 404 });
    }

    if (url === "/api/radar/briefing") {
      return Response.json(null);
    }

    return Response.json({});
  });
}

describe("RoutinesPage", () => {
  beforeEach(() => {
    searchParamsValue = "name=alpha-project";
    replaceMock.mockReset();
    pushMock.mockReset();
    window.localStorage.clear();
  });

  it("collects project jobs, Dream Cycle, Frontier Watch, and Research Radar", async () => {
    const fetchMock = buildFetchStub();
    vi.stubGlobal("fetch", fetchMock);

    render(<RoutinesPage />);

    expect(await screen.findByText("Recurring workbench")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Workspace" })).toHaveAttribute(
      "href",
      "/dashboard/project?name=alpha-project",
    );
    expect(await screen.findByText("Pipelines & Jobs")).toBeInTheDocument();
    expect(screen.getAllByText("Dream Cycle").length).toBeGreaterThan(0);
    expect(await screen.findByText("What should ScienceSwarm watch for this project?")).toBeInTheDocument();
    expect(await screen.findByText(/No radar configured yet/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/brain/watch-config?project=alpha-project",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
