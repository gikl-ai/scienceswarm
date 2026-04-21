// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "@/app/dashboard/page";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams("new=1"),
  usePathname: () => "/dashboard",
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

function stubProjectsFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "/api/projects") {
      return Response.json({
        projects: [
          {
            id: "my-first-test-project",
            slug: "my-first-test-project",
            name: "my_first_test_project",
            description: "Track frontier AI work.",
            status: "active",
            lastActive: "2026-04-09T12:00:00.000Z",
          },
        ],
      });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
}

describe("DashboardPage", () => {
  beforeEach(() => {
    pushMock.mockReset();
    vi.stubGlobal("fetch", stubProjectsFetch());
  });

  it("shows the normalized slug preview while creating a project", async () => {
    render(<DashboardPage />);

    // The ?new=1 page shows the creation form immediately — no list button.
    await screen.findByText("Create a new project");
    fireEvent.change(screen.getByPlaceholderText("project-alpha"), {
      target: { value: "my_first_test_project" },
    });

    expect(screen.getByText(/Project slug:/)).toHaveTextContent("Project slug: my-first-test-project");
    const workspaceCopy = screen.getByText(/Creates a local project workspace/);
    expect(workspaceCopy).toHaveTextContent(
      "Creates a local project workspace with upload, import, chat, and artifact review ready to use, then opens the project workspace.",
    );
    expect(workspaceCopy).not.toHaveTextContent("~/.scienceswarm");
  });


  it("opens the new project in its workspace onboarding flow after creation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/projects" && !init?.method) {
        return Response.json({ projects: [] });
      }

      if (url === "/api/projects" && init?.method === "POST") {
        return Response.json({
          project: {
            id: "my-first-test-project",
            slug: "my-first-test-project",
            name: "My First Test Project",
            description: "Track frontier AI work.",
            status: "active",
          },
        });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardPage />);

    // The ?new=1 page shows the creation form immediately.
    await screen.findByText("Create a new project");
    fireEvent.change(screen.getByPlaceholderText("project-alpha"), {
      target: { value: "My First Test Project" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("Analyzing citation patterns in public benchmark datasets..."),
      { target: { value: "Track frontier AI work." } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith(
        "/dashboard/project?name=my-first-test-project&description=Track+frontier+AI+work.&onboarding=1",
      );
    });
  });

  it("surfaces a create error when the API omits the created project payload", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/projects" && !init?.method) {
        return Response.json({ projects: [] });
      }

      if (url === "/api/projects" && init?.method === "POST") {
        return Response.json({ created: true });
      }

      throw new Error(`Unhandled fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardPage />);

    // The ?new=1 page shows the creation form immediately.
    await screen.findByText("Create a new project");
    fireEvent.change(screen.getByPlaceholderText("project-alpha"), {
      target: { value: "My First Test Project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    expect(
      await screen.findByText(/server response did not include project details/i),
    ).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });
});
