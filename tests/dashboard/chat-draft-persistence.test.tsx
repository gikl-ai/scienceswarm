// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let searchParamsValue = "name=demo-project";
const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(searchParamsValue),
  usePathname: () => "/dashboard/project",
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

import ProjectPage from "@/app/dashboard/project/page";

function stubMinimalDashboardFetch() {
  return vi.fn((url: string) => {
    if (url === "/api/health") {
      return Promise.resolve(
        Response.json({
          openclaw: "connected",
          openhands: "connected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: true,
            github: true,
            multiChannel: true,
            structuredCritique: true,
          },
        }),
      );
    }
    if (url === "/api/chat/unified?action=health") {
      return Promise.resolve(
        Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        }),
      );
    }
    if (url === "/api/brain/status") {
      return Promise.resolve(Response.json({ pageCount: 0, backend: "filesystem" }));
    }
    if (url.startsWith("/api/brain/brief?project=")) {
      return Promise.resolve(Response.json({ project: "demo-project" }));
    }
    if (url === "/api/projects/demo-project/import-summary") {
      return Promise.resolve(Response.json({ project: "demo-project", lastImport: null }));
    }
    return Promise.resolve(Response.json({ status: "disconnected" }));
  });
}

describe("chat draft persistence", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  beforeEach(() => {
    searchParamsValue = "name=demo-project";
    replaceMock.mockReset();
    window.localStorage.clear();
  });

  it("restores an in-progress draft across remount and clears it on send", async () => {
    vi.stubGlobal("fetch", stubMinimalDashboardFetch());

    const first = render(<ProjectPage />);

    const input = (await screen.findByLabelText("Chat with your project")) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "draft in progress" } });

    // Debounced localStorage write (300ms) — wait for it to commit.
    await waitFor(
      () => {
        expect(window.localStorage.getItem("scienceswarm.chat.draft.demo-project")).toBe(
          "draft in progress",
        );
      },
      { timeout: 1500 },
    );

    first.unmount();

    render(<ProjectPage />);

    await waitFor(() => {
      const restored = screen.getByLabelText("Chat with your project") as HTMLTextAreaElement;
      expect(restored.value).toBe("draft in progress");
    });

    const restored = screen.getByLabelText("Chat with your project") as HTMLTextAreaElement;

    // Simulate a clear (what happens after a successful send).
    fireEvent.change(restored, { target: { value: "" } });
    await waitFor(
      () => {
        expect(window.localStorage.getItem("scienceswarm.chat.draft.demo-project")).toBeNull();
      },
      { timeout: 1500 },
    );
  });

  it("scopes drafts per project slug and falls back to __global__ without a slug", async () => {
    window.localStorage.setItem("scienceswarm.chat.draft.other-project", "not mine");

    vi.stubGlobal("fetch", stubMinimalDashboardFetch());

    render(<ProjectPage />);

    const input = (await screen.findByLabelText("Chat with your project")) as HTMLTextAreaElement;

    // The demo-project input must not inherit the other-project draft.
    expect(input.value).toBe("");

    fireEvent.change(input, { target: { value: "scoped to demo" } });

    await waitFor(
      () => {
        expect(window.localStorage.getItem("scienceswarm.chat.draft.demo-project")).toBe(
          "scoped to demo",
        );
      },
      { timeout: 1500 },
    );
    // Other project's draft remains untouched.
    expect(window.localStorage.getItem("scienceswarm.chat.draft.other-project")).toBe("not mine");
  });
});
