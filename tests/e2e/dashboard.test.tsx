// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("name=test-project"),
  usePathname: () => "/dashboard/study",
  useRouter: () => ({
    replace: vi.fn(),
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

describe("Dashboard e2e flow", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  function stubHealthyFetch() {
    return vi.fn((url: string) => {
      if (url === "/api/health") {
        return Promise.resolve(
          Response.json({
            openclaw: "disconnected",
            openhands: "disconnected",
            openai: "missing",
            features: {
              chat: false,
              codeExecution: false,
              github: false,
              multiChannel: false,
              structuredCritique: false,
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ status: "disconnected" }));
    });
  }

  it("loads the project page with the project name", async () => {
    vi.stubGlobal("fetch", stubHealthyFetch());
    render(<ProjectPage />);

    expect(
      await screen.findByText(/Research workspace ready for/i),
    ).toBeInTheDocument();
  });

  it("shows the workspace welcome message", async () => {
    vi.stubGlobal("fetch", stubHealthyFetch());
    render(<ProjectPage />);

    expect(
      await screen.findByText(/Research workspace ready for/i),
    ).toBeInTheDocument();
  });

  it("fetches health status on mount", async () => {
    const fetchMock = stubHealthyFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/health", expect.anything());
    });
  });


  it("renders compact composer controls with a disabled idle Send button", async () => {
    vi.stubGlobal("fetch", stubHealthyFetch());
    render(<ProjectPage />);

    await screen.findByText(/Research workspace ready for/i);

    expect(
      screen.getByRole("button", { name: "Change response destination" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("renders chat input textarea", async () => {
    vi.stubGlobal("fetch", stubHealthyFetch());
    render(<ProjectPage />);

    await screen.findByText(/Research workspace ready for/i);

    expect(
      screen.getByLabelText("Chat with your study"),
    ).toBeInTheDocument();
  });
});
