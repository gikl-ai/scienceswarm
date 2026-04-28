// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/dashboard/study",
  useRouter: () => ({
    replace: replaceMock,
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

import ProjectPage from "@/app/dashboard/study/page";

describe("Project dashboard Dream Cycle regressions", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  beforeEach(() => {
    replaceMock.mockReset();
    window.localStorage.clear();
  });

  it("keeps gbrain controls off the study workspace surface", async () => {
    // gbrain now has a dedicated dashboard page, so the project
    // workspace should stay focused on files, visualizer, and chat.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "connected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: true,
            github: true,
            multiChannel: true,
            structuredCritique: true,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "connected",
          openhands: "connected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 22, backend: "pglite" });
      }

      if (url === "/api/brain/dream" && method === "GET") {
        return Response.json({ lastRun: null });
      }

      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          schedule: { enabled: true, cron: "0 3 * * *", mode: "full" },
          nextRun: "2026-04-19T10:00:00.000Z",
        });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({
          project: "my-project",
          nextMove: { recommendation: "Review the new overnight contradictions." },
          dueTasks: [],
          frontier: [],
        });
      }

      if (url === "/api/studies/my-project/import-summary") {
        return Response.json({ project: "my-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=my-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?study=my-project") {
        return Response.json({
          version: 1,
          project: "my-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/studies") {
        return Response.json({ studies: [] });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    await screen.findByText("No study selected");

    expect(screen.queryByText("Dream Cycle")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search research brain")).not.toBeInTheDocument();
  });
});
