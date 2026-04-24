// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let searchParamsValue = "name=demo-project";
const replaceMock = vi.fn();

interface LatestImportSummary {
  name: string;
  preparedFiles: number;
  detectedItems?: number;
  detectedBytes?: number;
  duplicateGroups?: number;
  generatedAt: string;
  source: string;
}

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
import { FILE_PREVIEW_LOCATION_STORAGE_KEY } from "@/lib/file-preview-preferences";

function createRuntimeStreamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
}

function createDeferredSseResponse(): {
  response: Response;
  send: (event: unknown) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  return {
    response: new Response(new ReadableStream({
      start(controller) {
        controllerRef = controller;
      },
    }), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Chat-Backend": "openclaw",
      },
    }),
    send(event: unknown) {
      controllerRef?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    close() {
      controllerRef?.enqueue(encoder.encode("data: [DONE]\n\n"));
      controllerRef?.close();
    },
  };
}

async function expandAllFolders() {
  fireEvent.click(await screen.findByRole("button", { name: "Expand all folders" }));
}

describe("Project dashboard smoke test", () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  function stubDashboardFetch(options?: {
    brainReady?: boolean;
    projectBrief?: Record<string, unknown>;
    importSummary?: LatestImportSummary | null;
    importSummaryStatus?: number;
    gbrainPages?: Array<Record<string, unknown>>;
    latestPaperLibraryScan?: Record<string, unknown> | null;
    paperLibraryScanStatus?: number;
  }) {
    const brainReady = options?.brainReady ?? true;
    const projectBrief = options?.projectBrief ?? {
      project: "demo-project",
      nextMove: {
        recommendation: "Review the imported sequencing notes before asking for a summary.",
      },
      topMatters: [],
      unresolvedRisks: [],
      dueTasks: [
        { path: "wiki/tasks/task-1.md", title: "Review notes", status: "open" },
      ],
      frontier: [
        {
          path: "wiki/entities/frontier/item-1.md",
          title: "CRISPR sequencing progress",
          status: "promoted",
          whyItMatters: "Directly relevant to the imported assay work.",
        },
      ],
    };
    const importSummary = options?.importSummary ?? null;
    const importSummaryStatus = options?.importSummaryStatus ?? 200;
    const gbrainPages = options?.gbrainPages ?? [];
    const latestPaperLibraryScan = options?.latestPaperLibraryScan ?? null;
    const paperLibraryScanStatus =
      options?.paperLibraryScanStatus ??
      (latestPaperLibraryScan ? 200 : 404);

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
        if (!brainReady) {
          return Promise.resolve(
            Response.json(
              {
                error: "No research brain is initialized yet.",
                code: "brain_not_initialized",
                nextAction:
                  "Open /setup to connect OpenClaw and initialize the local store, then import your first corpus from /dashboard/project.",
              },
              { status: 503 },
            ),
          );
        }

        return Promise.resolve(
          Response.json({
            pageCount: 0,
            backend: "filesystem",
          }),
        );
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        if (!brainReady) {
          return Promise.resolve(
            Response.json(
              {
                error: "No research brain is initialized yet.",
                code: "brain_not_initialized",
                nextAction:
                  "Open /setup to connect OpenClaw and initialize the local store, then import your first corpus from /dashboard/project.",
              },
              { status: 503 },
            ),
          );
        }

        return Promise.resolve(Response.json(projectBrief));
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Promise.resolve(Response.json(gbrainPages));
      }

      if (url === "/api/brain/paper-library/scan?project=demo-project&latest=1") {
        if (paperLibraryScanStatus !== 200) {
          return Promise.resolve(
            Response.json(
              {
                ok: false,
                error: {
                  code:
                    paperLibraryScanStatus === 404
                      ? "job_not_found"
                      : "paper_library_unavailable",
                  message:
                    paperLibraryScanStatus === 404
                      ? "Paper library scan not found."
                      : "Paper library lookup failed.",
                },
              },
              { status: paperLibraryScanStatus },
            ),
          );
        }

        return Promise.resolve(
          Response.json({
            ok: true,
            scan: latestPaperLibraryScan,
          }),
        );
      }

      if (url === "/api/projects/demo-project/import-summary") {
        if (importSummaryStatus !== 200) {
          return Promise.resolve(
            Response.json(
              { error: importSummaryStatus === 404 ? "Not found" : "Import summary lookup failed" },
              { status: importSummaryStatus },
            ),
          );
        }

        return Promise.resolve(
          Response.json({
            project: "demo-project",
            lastImport: importSummary,
          }),
        );
      }

      return Promise.resolve(
        Response.json({ status: "disconnected" }),
      );
    });
  }

  it("does not render fixed reasoning panels on the project workspace", async () => {
    const fetchMock = stubDashboardFetch({
      projectBrief: {
        project: "demo-project",
        generatedAt: "2026-04-22T20:00:00.000Z",
        nextMove: {
          recommendation: "Keep the current EGFR resistance plan unchanged until validation arrives.",
          missingEvidence: ["A replicated washout result tied to the resistant cohort."],
        },
        topMatters: [],
        unresolvedRisks: [
          {
            risk: "The new note is too thin to justify changing the working model.",
            evidence: ["wiki/entities/artifacts/weak-follow-up.md"],
          },
        ],
        dueTasks: [],
        frontier: [],
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    expect(await screen.findByLabelText("Chat with your project")).toBeInTheDocument();
    expect(screen.queryByText("Evidence Map")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Analyze evidence" })).not.toBeInTheDocument();
    expect(screen.queryByText("Project Understanding")).not.toBeInTheDocument();
    expect(screen.queryByText("Low-Confidence Project Read")).not.toBeInTheDocument();
  });

  it("renders the chat on a centered white canvas surface", async () => {
    const fetchMock = stubDashboardFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    const canvas = await screen.findByTestId("project-chat-canvas");
    const column = await screen.findByTestId("project-chat-column");

    expect(canvas).toHaveClass("bg-white");
    expect(canvas).toHaveClass("px-6");
    expect(column).toHaveClass("max-w-[60rem]");
    expect(column).toHaveClass("gap-6");
  });

  it("renders the refreshed composer surface with guidance and runtime context", async () => {
    const fetchMock = stubDashboardFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    const composer = await screen.findByTestId("project-chat-composer");
    expect(within(composer).getByText("Project Chat")).toBeInTheDocument();
    expect(
      within(composer).getByText("Enter to send. Shift+Enter for a new line."),
    ).toBeInTheDocument();
    expect(within(composer).getByText(/Drop files, type/i)).toBeInTheDocument();
    expect(within(composer).getByText("Chat mode")).toBeInTheDocument();
  });

  it("keeps the empty-state card hidden when the project already has paper-library activity", async () => {
    const fetchMock = stubDashboardFetch({
      latestPaperLibraryScan: {
        id: "scan-1",
        project: "demo-project",
        status: "ready_for_apply",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    expect(await screen.findByRole("link", { name: "Paper Library" })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            url === "/api/brain/paper-library/scan?project=demo-project&latest=1",
        ),
      ).toBe(true),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Your workspace is empty" }),
      ).not.toBeInTheDocument();
    });
  });

  it("shows the empty-state card when the project has no workspace, gbrain, import, or paper-library content", async () => {
    const fetchMock = stubDashboardFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    expect(await screen.findByRole("link", { name: "Paper Library" })).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Your workspace is empty" }),
    ).toBeInTheDocument();
  });

  it("shows a paper library launcher for the active project", async () => {
    const fetchMock = stubDashboardFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    const launcher = await screen.findByRole("link", { name: "Paper Library" });
    expect(launcher).toHaveAttribute("href", "/dashboard/gbrain?name=demo-project&view=paper-library");
  });


  it("restores the last project slug when the workspace URL is missing name", async () => {
    searchParamsValue = "";
    window.localStorage.setItem("scienceswarm.project.lastSlug", "demo-project");

    const fetchMock = stubDashboardFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/dashboard/project?name=demo-project");
    });
  });

  it("restores the remembered project's persisted chat after returning without a name param", async () => {
    searchParamsValue = "";
    window.localStorage.setItem("scienceswarm.project.lastSlug", "demo-project");
    window.localStorage.setItem(
      "scienceswarm.chat.demo-project",
      JSON.stringify({
        version: 1,
        conversationId: "web:demo-project:session-1",
        conversationBackend: "openclaw",
        messages: [
          {
            id: "remembered-user",
            role: "user",
            content: "hi from remembered project",
            timestamp: "2026-04-22T08:00:00.000Z",
          },
          {
            id: "remembered-assistant",
            role: "assistant",
            content: "Persisted answer",
            timestamp: "2026-04-22T08:00:01.000Z",
          },
        ],
      }),
    );
    replaceMock.mockImplementation((href: string) => {
      const nextUrl = new URL(href, "http://localhost");
      searchParamsValue = nextUrl.search.startsWith("?")
        ? nextUrl.search.slice(1)
        : nextUrl.search;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    const view = render(<ProjectPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/dashboard/project?name=demo-project");
    });

    view.rerender(<ProjectPage />);

    expect(await screen.findByText("Persisted answer")).toBeInTheDocument();
    expect(screen.getByText("hi from remembered project")).toBeInTheDocument();
  });

  it("shows an honest no-project state when the workspace URL has no active slug", async () => {
    searchParamsValue = "";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          agent: { type: "openclaw", status: "disconnected" },
          openclaw: "disconnected",
          nanoclaw: "disconnected",
          ollama: "connected",
          llmProvider: "local",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "disconnected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "local",
          ollamaModels: ["gemma4:latest"],
          configuredLocalModel: "gemma4",
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url === "/api/workspace?action=tree") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/workspace" && method === "POST") {
        return Response.json({ added: [], updated: [], missing: [], changed: [] });
      }

      if (url === "/api/projects") {
        return Response.json({ projects: [] });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    expect(await screen.findByText("No project selected")).toBeInTheDocument();
    expect(screen.queryByText(/Research workspace ready for/i)).not.toBeInTheDocument();

    const calledUrls = fetchMock.mock.calls.map(([input]) =>
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    expect(calledUrls.some((url) => url.includes("my-project"))).toBe(false);
    expect(calledUrls.some((url) => url.startsWith("/api/brain/brief?project="))).toBe(false);
    expect(calledUrls.some((url) => url.startsWith("/api/chat/thread"))).toBe(false);
  });

  it("renders the workspace tree and upload actions in the sidebar", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: true,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 2, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({
          tree: [
            {
              name: "papers",
              type: "directory",
              children: [{ name: "hubble-1929.pdf", type: "file", size: "552.7 KB" }],
            },
          ],
        });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([
          {
            slug: "wiki/entities/papers/demo/hubble-1929.md",
            title: "Hubble 1929",
            type: "paper",
            frontmatter: { project: "demo-project" },
          },
          {
            slug: "demo-project-critique.md",
            title: "Critique for Hubble 1929",
            type: "critique",
            frontmatter: { project: "demo-project", parent: "hubble-1929" },
          },
          {
            slug: "demo-project-untyped.md",
            title: "Untyped Artifact",
            type: null,
            frontmatter: { project: "demo-project" },
          },
          {
            slug: "wiki/projects/demo-project.md",
            title: "Demo Project Brain Page",
            type: "project",
            frontmatter: { project: "demo-project" },
          },
        ]);
      }

      if (
        url ===
        "/api/brain/page?slug=wiki%2Fentities%2Fpapers%2Fdemo%2Fhubble-1929.md"
      ) {
        return Response.json({
          content: "# Brain page\n\nConverted gbrain page",
        });
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    expect(await screen.findAllByText("Projects")).not.toHaveLength(0);
    expect(await screen.findByText("Brain Artifacts")).toBeInTheDocument();
    expect(screen.queryByText("Your workspace is empty")).not.toBeInTheDocument();
    expect(screen.queryByText("hubble-1929.pdf")).not.toBeInTheDocument();
    await expandAllFolders();
    expect(await screen.findByText("hubble-1929.pdf")).toBeInTheDocument();
    expect(screen.getByText("Hubble 1929")).toBeInTheDocument();
    expect(screen.getByText("Critique for Hubble 1929")).toBeInTheDocument();
    expect(screen.getByText("Untyped Artifact")).toBeInTheDocument();
    expect(screen.queryByText("Demo Project Brain Page")).not.toBeInTheDocument();

    const projectTreePanel = screen.getByTestId("project-tree-panel");
    expect(projectTreePanel).toHaveAttribute("data-project-tree-mode", "auto");
    fireEvent.click(screen.getByRole("button", { name: "Hide project tree" }));
    expect(projectTreePanel).toHaveAttribute("data-project-tree-mode", "closed");
    expect(screen.getByRole("button", { name: "Show project tree" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Show project tree" }));
    expect(projectTreePanel).toHaveAttribute("data-project-tree-mode", "open");
    expect(screen.getByRole("button", { name: "Hide project tree" })).toHaveAttribute("aria-pressed", "true");

    const chatInput = screen.getByLabelText("Chat with your project") as HTMLTextAreaElement;
    fireEvent.change(chatInput, { target: { value: "@critique" } });
    chatInput.setSelectionRange(9, 9);
    fireEvent.keyUp(chatInput);
    expect(screen.getByRole("option", { name: /Critique for Hubble 1929/ })).toBeInTheDocument();
    fireEvent.keyDown(chatInput, { key: "Escape" });
    expect(screen.queryByRole("list", { name: "Suggested prompts" })).not.toBeInTheDocument();

    const paperButton = screen.getByText("hubble-1929.pdf").closest("button");
    expect(paperButton).not.toBeNull();
    fireEvent.click(paperButton as HTMLButtonElement);
    // File preview defaults to the upper pane.
    const preview = await screen.findByLabelText("File visualizer");
    expect(within(preview).getByText("papers/hubble-1929.pdf")).toBeInTheDocument();
    expect(preview.querySelector("iframe")).toHaveAttribute(
      "src",
      "/api/workspace?action=raw&file=papers%2Fhubble-1929.pdf&projectId=demo-project",
    );
    expect(screen.queryByLabelText("Selected file preview")).not.toBeInTheDocument();

    expect(within(preview).getByRole("button", { name: "Use in chat" })).toBeInTheDocument();

    // Clicking another file replaces the upper-pane preview.
    const gbrainButton = screen.getByText("Hubble 1929").closest("button");
    expect(gbrainButton).not.toBeNull();
    fireEvent.click(gbrainButton as HTMLButtonElement);
    const gbrainPreview = await screen.findByRole("heading", { name: "Brain page" });
    expect(gbrainPreview).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+ Add" }));

    expect(screen.getByRole("button", { name: "Upload Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Import Local Folder/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for Changes" })).toBeInTheDocument();
  });

  it("does not abort slash-command loading when the user keeps typing", async () => {
    let slashRequestStarted = false;
    let resolveSlashCommands: (response: Response) => void = () => {
      throw new Error("Slash command request never started.");
    };
    let slashRequestAborted = false;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: true,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 1, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/workspace?action=watch&projectId=demo-project") {
        return Response.json({ revision: "watch-1", changed: false });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      if (url === "/api/openclaw/slash-commands") {
        slashRequestStarted = true;
        init?.signal?.addEventListener("abort", () => {
          slashRequestAborted = true;
        });
        return new Promise<Response>((resolve) => {
          resolveSlashCommands = resolve;
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    const chatInput = (await screen.findByLabelText("Chat with your project")) as HTMLTextAreaElement;

    fireEvent.change(chatInput, { target: { value: "/capt" } });
    chatInput.setSelectionRange(5, 5);
    fireEvent.keyUp(chatInput);
    expect(await screen.findByText("Loading installed skills...")).toBeInTheDocument();

    fireEvent.change(chatInput, { target: { value: "/captu" } });
    chatInput.setSelectionRange(6, 6);
    fireEvent.keyUp(chatInput);

    expect(slashRequestStarted).toBe(true);
    expect(slashRequestAborted).toBe(false);

    resolveSlashCommands(
      Response.json({
        commands: [
          {
            command: "capture",
            description: "Capture notes into the brain",
            kind: "skill",
            skillSlug: "scienceswarm-capture",
          },
        ],
      }),
    );

    expect(await screen.findByText("/capture")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("Loading installed skills...")).not.toBeInTheDocument();
    });
    expect(slashRequestAborted).toBe(false);
  });

  it("submits recognized slash commands through the dedicated command endpoint", async () => {
    const postEndpoints: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: true,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 1, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/openclaw/slash-commands") {
        return Response.json({
          commands: [
            {
              command: "capture",
              description: "Capture notes into the brain",
              kind: "skill",
              skillSlug: "scienceswarm-capture",
            },
          ],
        });
      }

      if (url === "/api/chat/command" && method === "POST") {
        postEndpoints.push(url);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          message: "/capture note this result",
          projectId: "demo-project",
        });
        return Response.json({
          response: "captured via command route",
          conversationId: "conv-demo",
          messages: [],
        });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        postEndpoints.push(url);
        throw new Error("unexpected unified chat send");
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    const input = await screen.findByLabelText("Chat with your project");
    fireEvent.change(input, { target: { value: "/capture note this result" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("captured via command route")).toBeInTheDocument();
    expect(postEndpoints).toEqual(["/api/chat/command"]);
  });

  it("lets the command endpoint handle ordinary slash text without a second chat request", async () => {
    const postEndpoints: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: true,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 1, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/openclaw/slash-commands") {
        return Response.json({
          commands: [
            {
              command: "capture",
              description: "Capture notes into the brain",
              kind: "skill",
              skillSlug: "scienceswarm-capture",
            },
          ],
        });
      }

      if (url === "/api/chat/command" && method === "POST") {
        postEndpoints.push(url);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          message: "/tmp",
          projectId: "demo-project",
        });
        return Response.json({
          response: "ordinary slash text",
          conversationId: "conv-demo",
          messages: [],
        });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        postEndpoints.push(url);
        throw new Error("unexpected unified chat send");
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    const input = await screen.findByLabelText("Chat with your project");
    fireEvent.change(input, { target: { value: "/tmp" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("ordinary slash text")).toBeInTheDocument();
    expect(postEndpoints).toEqual(["/api/chat/command"]);
  });

  it("requires runtime preview approval before hosted chat sends", async () => {
    const runtimePreviewBodies: Record<string, unknown>[] = [];
    const runtimeSessionBodies: Record<string, unknown>[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: true,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 1, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/runtime/health") {
        return Response.json({
          checkedAt: "2026-04-23T13:45:00.000Z",
          hosts: [
            {
              profile: {
                id: "openclaw",
                label: "OpenClaw",
                authMode: "local",
                authProvider: "openclaw",
                privacyClass: "local-network",
                transport: {
                  kind: "desktop-bridge",
                  protocol: "websocket",
                },
                capabilities: ["chat", "stream", "cancel", "resume", "mcp-tools"],
                lifecycle: {
                  canStream: true,
                  canCancel: true,
                  canResumeNativeSession: true,
                  canListNativeSessions: false,
                  cancelSemantics: "kill-wrapper-process",
                  resumeSemantics: "scienceSwarm-wrapper-session",
                },
                accountDisclosure: {
                  storesTokensInScienceSwarm: false,
                  requiresProjectPrivacy: "local-only",
                },
                mcpTools: [],
              },
              health: {
                status: "ready",
                checkedAt: "2026-04-23T13:45:00.000Z",
              },
              auth: {
                status: "not-required",
                authMode: "local",
                provider: "openclaw",
              },
              privacy: {
                privacyClass: "local-network",
                adapterProof: "declared-local",
              },
            },
            {
              profile: {
                id: "codex",
                label: "Codex",
                authMode: "subscription-native",
                authProvider: "openai",
                privacyClass: "hosted",
                transport: {
                  kind: "local-cli",
                  protocol: "stdio",
                  command: "codex",
                },
                capabilities: ["chat", "task", "stream", "cancel", "mcp-tools", "artifact-import"],
                lifecycle: {
                  canStream: true,
                  canCancel: true,
                  canResumeNativeSession: false,
                  canListNativeSessions: false,
                  cancelSemantics: "kill-wrapper-process",
                  resumeSemantics: "none",
                },
                accountDisclosure: {
                  storesTokensInScienceSwarm: false,
                  requiresProjectPrivacy: "cloud-ok",
                },
                mcpTools: [],
              },
              health: {
                status: "ready",
                checkedAt: "2026-04-23T13:45:00.000Z",
              },
              auth: {
                status: "authenticated",
                authMode: "subscription-native",
                provider: "openai",
              },
              privacy: {
                privacyClass: "hosted",
                adapterProof: "declared-hosted",
              },
            },
          ],
        });
      }

      if (url === "/api/runtime/sessions?projectId=demo-project") {
        return Response.json({ sessions: [] });
      }

      if (url === "/api/runtime/preview" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        runtimePreviewBodies.push(body);
        return Response.json({
          preview: {
            allowed: true,
            projectPolicy: "cloud-ok",
            hostId: "codex",
            mode: "chat",
            effectivePrivacyClass: "hosted",
            destinations: [
              {
                hostId: "codex",
                label: "Codex",
                privacyClass: "hosted",
              },
            ],
            dataIncluded: [
              {
                kind: "prompt",
                label: "Chat prompt",
                bytes: 22,
              },
            ],
            proof: {
              projectGatePassed: true,
              operationPrivacyClass: "hosted",
              adapterProof: "declared-hosted",
            },
            blockReason: null,
            requiresUserApproval: true,
            accountDisclosure: {
              authMode: "subscription-native",
              provider: "openai",
              billingClass: "subscription-native",
              accountSource: "host-cli-login",
              costCopyRequired: false,
            },
          },
        });
      }

      if (url === "/api/runtime/sessions/stream" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        runtimeSessionBodies.push(body);
        return createRuntimeStreamResponse([
          {
            event: {
              type: "message",
              payload: { text: "Codex direct answer" },
            },
          },
          {
            session: {
              id: "runtime-session-codex",
              conversationId: "codex-native-session",
              status: "completed",
            },
          },
        ]);
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(
      "scienceswarm.runtime.project.demo-project",
      JSON.stringify({
        projectPolicy: "cloud-ok",
        mode: "chat",
        selectedHostId: "codex",
        compareHostIds: ["openclaw"],
      }),
    );
    render(<ProjectPage />);

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-picker")).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId("composer-runtime-switcher")).toBeInTheDocument();

    const input = await screen.findByLabelText("Chat with your project");
    fireEvent.change(input, { target: { value: "Talk to Codex directly" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const previewDialog = await screen.findByRole("dialog", { name: "Runtime preview" });
    expect(previewDialog).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(runtimePreviewBodies).toEqual([
      expect.objectContaining({
        hostId: "codex",
        mode: "chat",
        projectId: "demo-project",
        projectPolicy: "cloud-ok",
        prompt: "Talk to Codex directly",
      }),
    ]);
    expect(runtimeSessionBodies).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));

    expect(await screen.findByText("Codex direct answer")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(runtimeSessionBodies).toEqual([
      expect.objectContaining({
        hostId: "codex",
        mode: "chat",
        projectId: "demo-project",
        projectPolicy: "cloud-ok",
        approvalState: "approved",
        prompt: "Talk to Codex directly",
      }),
    ]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Runtime preview" })).not.toBeInTheDocument();
    });
  });

  it("auto-sends chat when runtime preview does not require approval", async () => {
    const runtimePreviewBodies: Record<string, unknown>[] = [];
    const runtimeSessionBodies: Record<string, unknown>[] = [];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: true,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 1, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/runtime/health") {
        return Response.json({
          checkedAt: "2026-04-23T13:45:00.000Z",
          hosts: [
            {
              profile: {
                id: "openclaw",
                label: "OpenClaw",
                authMode: "local",
                authProvider: "openclaw",
                privacyClass: "local-network",
                transport: {
                  kind: "desktop-bridge",
                  protocol: "websocket",
                },
                capabilities: ["chat", "stream", "cancel", "resume", "mcp-tools"],
                lifecycle: {
                  canStream: true,
                  canCancel: true,
                  canResumeNativeSession: true,
                  canListNativeSessions: false,
                  cancelSemantics: "kill-wrapper-process",
                  resumeSemantics: "scienceSwarm-wrapper-session",
                },
                accountDisclosure: {
                  storesTokensInScienceSwarm: false,
                  requiresProjectPrivacy: "local-only",
                },
                mcpTools: [],
              },
              health: {
                status: "ready",
                checkedAt: "2026-04-23T13:45:00.000Z",
              },
              auth: {
                status: "not-required",
                authMode: "local",
                provider: "openclaw",
              },
              privacy: {
                privacyClass: "local-network",
                adapterProof: "declared-local",
              },
            },
            {
              profile: {
                id: "codex",
                label: "Codex",
                authMode: "subscription-native",
                authProvider: "openai",
                privacyClass: "hosted",
                transport: {
                  kind: "local-cli",
                  protocol: "stdio",
                  command: "codex",
                },
                capabilities: ["chat", "task", "stream", "cancel", "mcp-tools", "artifact-import"],
                lifecycle: {
                  canStream: true,
                  canCancel: true,
                  canResumeNativeSession: false,
                  canListNativeSessions: false,
                  cancelSemantics: "kill-wrapper-process",
                  resumeSemantics: "none",
                },
                accountDisclosure: {
                  storesTokensInScienceSwarm: false,
                  requiresProjectPrivacy: "cloud-ok",
                },
                mcpTools: [],
              },
              health: {
                status: "ready",
                checkedAt: "2026-04-23T13:45:00.000Z",
              },
              auth: {
                status: "authenticated",
                authMode: "subscription-native",
                provider: "openai",
              },
              privacy: {
                privacyClass: "hosted",
                adapterProof: "declared-hosted",
              },
            },
          ],
        });
      }

      if (url === "/api/runtime/sessions?projectId=demo-project") {
        return Response.json({ sessions: [] });
      }

      if (url === "/api/runtime/preview" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        runtimePreviewBodies.push(body);
        return Response.json({
          preview: {
            allowed: true,
            projectPolicy: "cloud-ok",
            hostId: "codex",
            mode: "chat",
            effectivePrivacyClass: "hosted",
            destinations: [
              {
                hostId: "codex",
                label: "Codex",
                privacyClass: "hosted",
              },
            ],
            dataIncluded: [
              {
                kind: "prompt",
                label: "Chat prompt",
                bytes: 22,
              },
            ],
            proof: {
              projectGatePassed: true,
              operationPrivacyClass: "hosted",
              adapterProof: "declared-hosted",
            },
            blockReason: null,
            requiresUserApproval: false,
            accountDisclosure: {
              authMode: "subscription-native",
              provider: "openai",
              billingClass: "subscription-native",
              accountSource: "host-cli-login",
              costCopyRequired: false,
            },
          },
        });
      }

      if (url === "/api/runtime/sessions/stream" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        runtimeSessionBodies.push(body);
        return createRuntimeStreamResponse([
          {
            event: {
              type: "message",
              payload: { text: "Codex auto-approved answer" },
            },
          },
          {
            session: {
              id: "runtime-session-codex",
              conversationId: "codex-native-session",
              status: "completed",
            },
          },
        ]);
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(
      "scienceswarm.runtime.project.demo-project",
      JSON.stringify({
        projectPolicy: "cloud-ok",
        mode: "chat",
        selectedHostId: "codex",
        compareHostIds: ["openclaw"],
      }),
    );
    render(<ProjectPage />);

    await waitFor(() => {
      expect(screen.queryByTestId("runtime-picker")).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId("composer-runtime-switcher")).toBeInTheDocument();

    const input = await screen.findByLabelText("Chat with your project");
    fireEvent.change(input, { target: { value: "Talk to Codex with auto approval" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Codex auto-approved answer")).toBeInTheDocument();
    expect(runtimePreviewBodies).toEqual([
      expect.objectContaining({
        hostId: "codex",
        mode: "chat",
        projectId: "demo-project",
        projectPolicy: "cloud-ok",
        prompt: "Talk to Codex with auto approval",
      }),
    ]);
    expect(runtimeSessionBodies).toEqual([
      expect.objectContaining({
        hostId: "codex",
        mode: "chat",
        projectId: "demo-project",
        projectPolicy: "cloud-ok",
        approvalState: "not-required",
        prompt: "Talk to Codex with auto approval",
      }),
    ]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Runtime preview" })).not.toBeInTheDocument();
    });
  });

  it("opens project navigation from the mobile projects button", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
            {
              id: "demo-project-2",
              slug: "demo-project-2",
              name: "Second Project",
              status: "idle",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Open projects" }));

    const navigationDialog = await screen.findByRole("dialog", { name: "Project navigation" });
    expect(within(navigationDialog).getByText("Second Project")).toBeInTheDocument();

    fireEvent.click(within(navigationDialog).getByRole("button", { name: "Close projects" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Project navigation" })).not.toBeInTheDocument();
    });
  });

  it("shows generated files inline with a restored in-flight assistant turn", async () => {
    const prompt = "Draft a five-step research plan for Alpha Genome Review.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({
          tree: [{ name: "research_plan.md", type: "file", size: "1.2 KB" }],
        });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: "web:demo-project:session-1",
          messages: [
            {
              id: "user-1",
              role: "user",
              content: prompt,
              timestamp: "2026-04-18T06:50:20.000Z",
              channel: "web",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "",
              timestamp: "2026-04-18T06:50:22.000Z",
              chatMode: "openclaw-tools",
              taskPhases: [
                { id: "reading-file", label: "Reading file", status: "completed" },
                { id: "drafting-plan", label: "Drafting plan", status: "active" },
                { id: "done", label: "Done", status: "pending" },
              ],
            },
          ],
          artifactProvenance: [
            {
              projectPath: "research_plan.md",
              sourceFiles: [],
              prompt,
              tool: "OpenClaw CLI",
              createdAt: "2026-04-18T06:50:30.000Z",
            },
          ],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    expect(await screen.findByText("Drafting plan")).toBeInTheDocument();
    expect(await screen.findByLabelText("Open generated file research_plan.md")).toBeInTheDocument();
  });

  it("keeps repeated identical prompts mapped to their own assistant-turn artifacts", async () => {
    const prompt = "Draft a five-step research plan for Alpha Genome Review.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({
          tree: [
            { name: "research_plan_v1.md", type: "file", size: "1.2 KB" },
            { name: "research_plan_v2.md", type: "file", size: "1.4 KB" },
          ],
        });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: "web:demo-project:session-1",
          messages: [
            {
              id: "user-1",
              role: "user",
              content: prompt,
              timestamp: "2026-04-18T06:50:20.000Z",
              channel: "web",
            },
            {
              id: "assistant-1",
              role: "assistant",
              content: "First plan ready.",
              timestamp: "2026-04-18T06:50:40.000Z",
              chatMode: "openclaw-tools",
            },
            {
              id: "user-2",
              role: "user",
              content: prompt,
              timestamp: "2026-04-18T06:51:20.000Z",
              channel: "web",
            },
            {
              id: "assistant-2",
              role: "assistant",
              content: "Second plan ready.",
              timestamp: "2026-04-18T06:51:40.000Z",
              chatMode: "openclaw-tools",
            },
          ],
          artifactProvenance: [
            {
              projectPath: "research_plan_v1.md",
              sourceFiles: [],
              prompt,
              tool: "OpenClaw CLI",
              createdAt: "2026-04-18T06:50:45.000Z",
            },
            {
              projectPath: "research_plan_v2.md",
              sourceFiles: [],
              prompt,
              tool: "OpenClaw CLI",
              createdAt: "2026-04-18T06:51:45.000Z",
            },
          ],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    // Assistant bubbles intentionally do NOT carry data-chat-selectable (that
    // attribute drives a white ::selection highlight that would be invisible
    // on the white assistant bubble). Target the outer bubble via its
    // stable `data-testid` hook instead — survives layout refactors.
    const firstAssistantGroup = (await screen.findByText("First plan ready."))
      .closest("[data-testid='chat-bubble']")
      ?.parentElement?.parentElement as HTMLElement;
    const secondAssistantGroup = (await screen.findByText("Second plan ready."))
      .closest("[data-testid='chat-bubble']")
      ?.parentElement?.parentElement as HTMLElement;

    expect(within(firstAssistantGroup).getByLabelText("Open generated file research_plan_v1.md")).toBeInTheDocument();
    expect(within(firstAssistantGroup).queryByLabelText("Open generated file research_plan_v2.md")).not.toBeInTheDocument();
    expect(within(secondAssistantGroup).getByLabelText("Open generated file research_plan_v2.md")).toBeInTheDocument();
    expect(within(secondAssistantGroup).queryByLabelText("Open generated file research_plan_v1.md")).not.toBeInTheDocument();
  });

  it("searches the research brain and opens the best compiled current-view result", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);
    expect(await screen.findByTestId("chat-input")).toBeInTheDocument();
    expect(screen.queryByText("Dream Cycle")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search research brain")).not.toBeInTheDocument();
  });

  it("surfaces brain status failures with a visible retry path", async () => {
    let brainStatusCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        brainStatusCalls += 1;
        if (brainStatusCalls === 1) {
          return Response.json({ error: "PGLite is locked" }, { status: 500 });
        }
        return Response.json({ pageCount: 1, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Research brain is unavailable.");
    expect(screen.getByText("PGLite is locked")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry brain status" }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  it("sends the visible selected file as active chat context without adding a context chip", async () => {
    window.localStorage.setItem(FILE_PREVIEW_LOCATION_STORAGE_KEY, "chat-pane");
    const chatBodies: Array<Record<string, unknown>> = [];
    let responseCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({
          tree: [
            {
              name: "code",
              type: "directory",
              children: [{ name: "analysis.py", type: "file", size: "19 B" }],
            },
          ],
        });
      }

      if (url === "/api/workspace?action=file&file=code%2Fanalysis.py&projectId=demo-project") {
        return Response.json({ file: "code/analysis.py", content: "print('selected')\n" });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        chatBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        responseCount += 1;
        return Response.json({
          response: `answer-${responseCount}`,
          conversationId: "conv-demo",
          messages: [],
        });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    await expandAllFolders();
    const fileButton = (await screen.findByText("analysis.py")).closest("button");
    expect(fileButton).not.toBeNull();
    fireEvent.click(fileButton as HTMLButtonElement);

    // The chat-pane preference renders the file card in chat without making it context.
    const visualizer = await screen.findByLabelText("File visualizer");
    expect(within(visualizer).getByText("code/analysis.py")).toBeInTheDocument();
    expect(within(visualizer).getByRole("button", { name: "Split view" })).toBeInTheDocument();
    expect(within(visualizer).queryByRole("button", { name: "Use in chat" })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Context:/)).not.toBeInTheDocument();

    const input = await screen.findByLabelText("Chat with your project");
    fireEvent.change(input, { target: { value: "summarize the selected file" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("answer-1")).toBeInTheDocument();

    // The visible preview is active context, but it is not added as a persistent context chip.
    expect(chatBodies[0]).toMatchObject({
      message: "summarize the selected file",
      files: [],
      activeFile: {
        path: "code/analysis.py",
        content: "print('selected')",
      },
    });
  });

  it("restores gbrain-backed chat file cards after refresh", async () => {
    window.localStorage.setItem(FILE_PREVIEW_LOCATION_STORAGE_KEY, "chat-pane");
    window.localStorage.setItem(
      "scienceswarm.chat.demo-project",
      JSON.stringify({
        version: 1,
        conversationId: null,
        messages: [
          {
            id: "gbrain-static-card",
            role: "system",
            content: "__FILE_STATIC__:Brain Artifacts/gbrain:wiki/artifacts/cat-image",
            timestamp: "2026-04-21T18:30:00.000Z",
          },
        ],
      }),
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/workspace" && method === "POST") {
        return Response.json({ added: [], updated: [], missing: [], changed: [] });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/brain/read?path=wiki%2Fartifacts%2Fcat-image") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      if (url === "/api/brain/file?slug=wiki%2Fartifacts%2Fcat-image&metadata=1") {
        return Response.json({
          mime: "image/png",
          source_filename: "cat-image.png",
          size: 2048,
        });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    const visualizer = await screen.findByLabelText("File visualizer");
    const image = within(visualizer).getByRole("img", {
      name: "Brain Artifacts/gbrain:wiki/artifacts/cat-image",
    });
    expect(image).toHaveAttribute(
      "src",
      "/api/brain/file?slug=wiki%2Fartifacts%2Fcat-image",
    );
    expect(screen.queryByText("Cannot preview this file type.")).not.toBeInTheDocument();
  });

  it("aborts in-flight gbrain preview restoration when the chat file card unmounts", async () => {
    window.localStorage.setItem(FILE_PREVIEW_LOCATION_STORAGE_KEY, "chat-pane");
    window.localStorage.setItem(
      "scienceswarm.chat.demo-project",
      JSON.stringify({
        version: 1,
        conversationId: null,
        messages: [
          {
            id: "gbrain-static-card",
            role: "system",
            content: "__FILE_STATIC__:Brain Artifacts/gbrain:wiki/artifacts/cat-image",
            timestamp: "2026-04-21T18:30:00.000Z",
          },
        ],
      }),
    );

    let gbrainReadAborted = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Promise.resolve(
          Response.json({
            openclaw: "connected",
            openhands: "disconnected",
            openai: "configured",
            features: {
              chat: true,
              codeExecution: false,
              github: false,
              multiChannel: false,
              structuredCritique: false,
            },
          }),
        );
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(
          Response.json({
            openclaw: "connected",
            nanoclaw: "disconnected",
            openhands: "disconnected",
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
        return Promise.resolve(Response.json({ project: "demo-project", dueTasks: [], frontier: [] }));
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Promise.resolve(Response.json({ project: "demo-project", lastImport: null }));
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/workspace" && method === "POST") {
        return Promise.resolve(Response.json({ added: [], updated: [], missing: [], changed: [] }));
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Promise.resolve(Response.json([]));
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Promise.resolve(
          Response.json({
            version: 1,
            project: "demo-project",
            conversationId: null,
            messages: [],
          }),
        );
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/brain/read?path=wiki%2Fartifacts%2Fcat-image") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => {
            gbrainReadAborted = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }

      if (url === "/api/projects") {
        return Promise.resolve(
          Response.json({
            projects: [
              {
                id: "demo-project",
                slug: "demo-project",
                name: "Demo Project",
                status: "active",
              },
            ],
          }),
        );
      }

      return Promise.resolve(Response.json({ status: "disconnected" }));
    });

    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<ProjectPage />);

    await screen.findByLabelText("File visualizer");
    unmount();

    await waitFor(() => {
      expect(gbrainReadAborted).toBe(true);
    });
  });

  it("shows a retryable error when restored gbrain previews cannot be loaded", async () => {
    window.localStorage.setItem(FILE_PREVIEW_LOCATION_STORAGE_KEY, "chat-pane");
    window.localStorage.setItem(
      "scienceswarm.chat.demo-project",
      JSON.stringify({
        version: 1,
        conversationId: null,
        messages: [
          {
            id: "gbrain-static-card",
            role: "system",
            content: "__FILE_STATIC__:Brain Artifacts/gbrain:wiki/artifacts/cat-image",
            timestamp: "2026-04-21T18:30:00.000Z",
          },
        ],
      }),
    );

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Promise.resolve(
          Response.json({
            openclaw: "connected",
            openhands: "disconnected",
            openai: "configured",
            features: {
              chat: true,
              codeExecution: false,
              github: false,
              multiChannel: false,
              structuredCritique: false,
            },
          }),
        );
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(
          Response.json({
            openclaw: "connected",
            nanoclaw: "disconnected",
            openhands: "disconnected",
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
        return Promise.resolve(Response.json({ project: "demo-project", dueTasks: [], frontier: [] }));
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Promise.resolve(Response.json({ project: "demo-project", lastImport: null }));
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/workspace" && method === "POST") {
        return Promise.resolve(Response.json({ added: [], updated: [], missing: [], changed: [] }));
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Promise.resolve(Response.json([]));
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Promise.resolve(
          Response.json({
            version: 1,
            project: "demo-project",
            conversationId: null,
            messages: [],
          }),
        );
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/brain/read?path=wiki%2Fartifacts%2Fcat-image") {
        return Promise.reject(new Error("read failed"));
      }

      if (url === "/api/brain/file?slug=wiki%2Fartifacts%2Fcat-image&metadata=1") {
        return Promise.reject(new Error("metadata failed"));
      }

      if (url === "/api/brain/page?slug=wiki%2Fartifacts%2Fcat-image") {
        return Promise.reject(new Error("page failed"));
      }

      if (url === "/api/projects") {
        return Promise.resolve(
          Response.json({
            projects: [
              {
                id: "demo-project",
                slug: "demo-project",
                name: "Demo Project",
                status: "active",
              },
            ],
          }),
        );
      }

      return Promise.resolve(Response.json({ status: "disconnected" }));
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    const visualizer = await screen.findByLabelText("File visualizer");
    expect(await within(visualizer).findByText("Failed to load wiki/artifacts/cat-image.")).toBeInTheDocument();
    expect(within(visualizer).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("reloads the selected file preview after a streamed chat turn updates it", async () => {
    let fileReads = 0;
    const encoder = new TextEncoder();
    const streamChatResponse = () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            text: "Updated summary saved.",
            conversationId: "web:demo-project:session-1",
            generatedFiles: ["docs/summary.md"],
          })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Chat-Backend": "openclaw",
        },
      });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({
          tree: [
            {
              name: "docs",
              type: "directory",
              children: [{ name: "summary.md", type: "file", size: "1 KB" }],
            },
          ],
        });
      }

      if (url === "/api/workspace?action=file&file=docs%2Fsummary.md&projectId=demo-project") {
        fileReads += 1;
        return Response.json({
          file: "docs/summary.md",
          content: fileReads === 1 ? "# Summary\n\nBefore stream" : "# Summary\n\nAfter stream",
        });
      }

      if (url === "/api/workspace" && method === "POST") {
        return Response.json({ added: [], updated: [], missing: [], changed: [] });
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Response.json([]);
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return streamChatResponse();
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    await expandAllFolders();
    const fileButton = (await screen.findByText("summary.md")).closest("button");
    expect(fileButton).not.toBeNull();
    fireEvent.click(fileButton as HTMLButtonElement);

    const preview = await screen.findByLabelText("File visualizer");
    expect(await within(preview).findByText("Before stream")).toBeInTheDocument();

    const input = await screen.findByLabelText("Chat with your project");
    fireEvent.change(input, { target: { value: "refresh the selected summary" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Updated summary saved.")).toBeInTheDocument();
    await waitFor(() => {
      expect(fileReads).toBeGreaterThanOrEqual(2);
      expect(within(preview).getByText("After stream")).toBeInTheDocument();
    });
  });

  it("keeps the last selected file visible when rapid preview requests resolve out of order", async () => {
    let resolveAlpha!: (response: Response) => void;
    let resolveBeta!: (response: Response) => void;
    const alphaResponse = new Promise<Response>((resolve) => {
      resolveAlpha = resolve;
    });
    const betaResponse = new Promise<Response>((resolve) => {
      resolveBeta = resolve;
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Promise.resolve(Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        }));
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        }));
      }

      if (url === "/api/brain/status") {
        return Promise.resolve(Response.json({ pageCount: 0, backend: "filesystem" }));
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Promise.resolve(Response.json({ project: "demo-project", dueTasks: [], frontier: [] }));
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Promise.resolve(Response.json({ project: "demo-project", lastImport: null }));
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Promise.resolve(Response.json({
          tree: [
            {
              name: "docs",
              type: "directory",
              children: [
                { name: "alpha.md", type: "file", size: "9 B" },
                { name: "beta.md", type: "file", size: "8 B" },
              ],
            },
          ],
        }));
      }

      if (url === "/api/workspace?action=file&file=docs%2Falpha.md&projectId=demo-project") {
        return alphaResponse;
      }

      if (url === "/api/workspace?action=file&file=docs%2Fbeta.md&projectId=demo-project") {
        return betaResponse;
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Promise.resolve(Response.json([]));
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Promise.resolve(Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        }));
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/projects") {
        return Promise.resolve(Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        }));
      }

      return Promise.resolve(Response.json({ status: "disconnected" }));
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    await expandAllFolders();
    const alphaButton = (await screen.findByText("alpha.md")).closest("button");
    const betaButton = (await screen.findByText("beta.md")).closest("button");
    expect(alphaButton).not.toBeNull();
    expect(betaButton).not.toBeNull();

    fireEvent.click(alphaButton as HTMLButtonElement);
    fireEvent.click(betaButton as HTMLButtonElement);
    resolveBeta(Response.json({ file: "docs/beta.md", content: "# Beta" }));

    // With upper-pane previews, the active preview is the single visualizer.
    const activeVisualizer = await screen.findByLabelText("File visualizer");
    expect(await within(activeVisualizer).findByRole("heading", { name: "Beta" })).toBeInTheDocument();

    resolveAlpha(Response.json({ file: "docs/alpha.md", content: "# Alpha" }));
    await waitFor(() => {
      expect(within(activeVisualizer).getByText("docs/beta.md")).toBeInTheDocument();
      expect(within(activeVisualizer).queryByRole("heading", { name: "Alpha" })).not.toBeInTheDocument();
    });
  });

  it("restores chat with the latest response after chat is closed during a send", async () => {
    const stream = createDeferredSseResponse();

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Promise.resolve(Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        }));
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        }));
      }

      if (url === "/api/brain/status") {
        return Promise.resolve(Response.json({ pageCount: 0, backend: "filesystem" }));
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Promise.resolve(Response.json({ project: "demo-project", dueTasks: [], frontier: [] }));
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Promise.resolve(Response.json({ project: "demo-project", lastImport: null }));
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Promise.resolve(Response.json([]));
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Promise.resolve(Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        }));
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Promise.resolve(stream.response);
      }

      if (url === "/api/projects") {
        return Promise.resolve(Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        }));
      }

      return Promise.resolve(Response.json({ status: "disconnected" }));
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    const input = await screen.findByLabelText("Chat with your project");
    fireEvent.change(input, { target: { value: "keep streaming" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByTestId("chat-streaming-spinner")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-activity-spinner")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(screen.getByRole("button", { name: "Show chat" })).toBeInTheDocument();
    expect(screen.getByTestId("project-chat-run-state-row")).toHaveTextContent("Working");
    expect(screen.queryByTestId("chat-activity-spinner")).not.toBeInTheDocument();

    stream.send({
      text: "restored answer",
      conversationId: "conv-demo",
      messages: [],
    });
    stream.close();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chat/unified",
        expect.objectContaining({ method: "POST" }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Show chat" }));
    expect(await screen.findByText("restored answer")).toBeInTheDocument();
  });

  it("shows the compact fallback run-state row with active phase details when chat is hidden mid-stream", async () => {
    const stream = createDeferredSseResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Promise.resolve(Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        }));
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        }));
      }

      if (url === "/api/brain/status") {
        return Promise.resolve(Response.json({ pageCount: 0, backend: "filesystem" }));
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Promise.resolve(Response.json({ project: "demo-project", dueTasks: [], frontier: [] }));
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Promise.resolve(Response.json({ project: "demo-project", lastImport: null }));
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/brain/list?project=demo-project") {
        return Promise.resolve(Response.json([]));
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Promise.resolve(Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        }));
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Promise.resolve(stream.response);
      }

      if (url === "/api/projects") {
        return Promise.resolve(Response.json({
          projects: [
            {
              id: "demo-project",
              slug: "demo-project",
              name: "Demo Project",
              status: "active",
            },
          ],
        }));
      }

      return Promise.resolve(Response.json({ status: "disconnected" }));
    });

    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectPage />);

    const input = await screen.findByLabelText("Chat with your project");
    fireEvent.change(input, { target: { value: "keep streaming" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByTestId("chat-streaming-spinner")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));

    stream.send({
      taskPhases: [
        { id: "reading-file", label: "Reading file", status: "completed" },
        { id: "drafting-plan", label: "Drafting plan", status: "active" },
        { id: "done", label: "Done", status: "pending" },
      ],
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-chat-run-state-row")).toHaveTextContent("Drafting plan");
      expect(screen.getByTestId("project-chat-run-state-row")).toHaveTextContent("1/3 phases");
    });
    expect(screen.queryByTestId("chat-activity-spinner")).not.toBeInTheDocument();

    stream.send({
      text: "finished answer",
      conversationId: "conv-demo",
      messages: [],
    });
    stream.close();

    await waitFor(() => {
      expect(screen.queryByTestId("project-chat-run-state-row")).not.toBeInTheDocument();
    });
  });

  it("cycles previously sent prompts with ArrowUp and ArrowDown in the chat input", async () => {
    let responseCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project" });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        responseCount += 1;
        return Response.json({
          response: `response-${responseCount}`,
          conversationId: "conv-demo",
          messages: [],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    const input = await screen.findByLabelText("Chat with your project");

    fireEvent.change(input, { target: { value: "first prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("response-1")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "second prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("response-2")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "draft prompt" } });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("second prompt");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input).toHaveValue("first prompt");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveValue("second prompt");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveValue("draft prompt");
  });

  it("clears the composer immediately after a successful chat send starts", async () => {
    let resolveUnifiedResponse: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Promise.resolve(
          Response.json({
            openclaw: "connected",
            openhands: "disconnected",
            openai: "configured",
            features: {
              chat: true,
              codeExecution: false,
              github: false,
              multiChannel: false,
              structuredCritique: false,
            },
          }),
        );
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(
          Response.json({
            openclaw: "connected",
            nanoclaw: "disconnected",
            openhands: "disconnected",
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

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Promise.resolve(
          Response.json({
            version: 1,
            project: "demo-project",
            conversationId: null,
            messages: [],
          }),
        );
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveUnifiedResponse = resolve;
        });
      }

      return Promise.resolve(Response.json({ status: "disconnected" }));
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    const input = await screen.findByLabelText("Chat with your project");

    fireEvent.change(input, { target: { value: "clear me after send" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([request, requestInit]) =>
          String(request) === "/api/chat/unified"
          && (requestInit as RequestInit | undefined)?.method === "POST"),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(input).toHaveValue("");
    });

    expect(resolveUnifiedResponse).not.toBeNull();
    resolveUnifiedResponse!(
      Response.json({
        response: "response-1",
        conversationId: "conv-demo",
        messages: [],
      }),
    );

    expect(await screen.findByText("response-1")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("does not overwrite a newer draft when the in-flight send fails", async () => {
    let rejectUnifiedResponse: ((error: Error) => void) | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Promise.resolve(
          Response.json({
            openclaw: "connected",
            openhands: "disconnected",
            openai: "configured",
            features: {
              chat: true,
              codeExecution: false,
              github: false,
              multiChannel: false,
              structuredCritique: false,
            },
          }),
        );
      }

      if (url === "/api/chat/unified?action=health") {
        return Promise.resolve(
          Response.json({
            openclaw: "connected",
            nanoclaw: "disconnected",
            openhands: "disconnected",
            llmProvider: "openai",
            ollamaModels: [],
            configuredLocalModel: null,
          }),
        );
      }

      if (url === "/api/brain/status") {
        return Promise.resolve(Response.json({ pageCount: 0, backend: "filesystem" }));
      }

      if (url.startsWith("/api/workspace/summary?project=")) {
        return Promise.resolve(
          Response.json({
            summary: {
              project: "demo-project",
              files: [],
              generatedArtifacts: [],
              activity: [],
            },
          }),
        );
      }

      if (url === "/api/settings/file-preview-location") {
        return Promise.resolve(Response.json({ location: "workspace-pane" }));
      }

      if (url === "/api/projects/demo-project/import-state") {
        return Promise.resolve(
          Response.json({
            projectId: "demo-project",
            projectName: "demo-project",
            status: "idle",
            counts: { total: 0, processed: 0, succeeded: 0, failed: 0 },
            items: [],
          }),
        );
      }

      if (url === "/api/projects/demo-project") {
        return Promise.resolve(
          Response.json({
            project: {
              id: "demo-project",
              name: "demo-project",
              path: "/tmp/demo-project",
            },
          }),
        );
      }

      if (url.startsWith("/api/brain/pages?project=")) {
        return Promise.resolve(Response.json({ pages: [] }));
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Promise.resolve(Response.json({ project: "demo-project" }));
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Promise.resolve(Response.json({ project: "demo-project", lastImport: null }));
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Promise.resolve(Response.json({ tree: [] }));
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Promise.resolve(
          Response.json({
            version: 1,
            project: "demo-project",
            conversationId: null,
            messages: [],
          }),
        );
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Promise.resolve(Response.json({ ok: true }));
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return new Promise<Response>((_, reject) => {
          rejectUnifiedResponse = (error) => reject(error);
        });
      }

      return Promise.resolve(Response.json({ status: "disconnected" }));
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    const input = await screen.findByLabelText("Chat with your project");

    fireEvent.change(input, { target: { value: "original prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(input).toHaveValue("");
    });

    fireEvent.change(input, { target: { value: "newer draft" } });

    expect(rejectUnifiedResponse).not.toBeNull();
    rejectUnifiedResponse!(new Error("chat failed"));

    await waitFor(() => {
      expect(input).toHaveValue("newer draft");
    });
  });

  it("restores the switched-project draft when prompt history navigation unwinds", async () => {
    window.localStorage.setItem(
      "scienceswarm.chat.draft.alpha-project",
      "alpha restored draft",
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            { id: "demo-project", slug: "demo-project", name: "Demo Project", status: "active" },
            { id: "alpha-project", slug: "alpha-project", name: "Alpha Project", status: "active" },
          ],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({
          response: "history answer",
          conversationId: "conv-history",
          messages: [],
        });
      }

      if (url.startsWith("/api/brain/status")) {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        const project = new URL(`http://localhost${url}`).searchParams.get("project") ?? "demo-project";
        return Response.json({ project, dueTasks: [], frontier: [] });
      }

      if (url.startsWith("/api/projects/") && url.endsWith("/import-summary")) {
        const project = url.split("/")[3] ?? "demo-project";
        return Response.json({ project, lastImport: null });
      }

      if (url.startsWith("/api/projects/") && !url.includes("/import-summary") && !url.includes("/import-state")) {
        const project = url.split("/")[3] ?? "demo-project";
        return Response.json({
          project: {
            id: project,
            name: project,
            path: `/tmp/${project}`,
          },
        });
      }

      if (url.startsWith("/api/projects/") && url.endsWith("/import-state")) {
        const project = url.split("/")[3] ?? "demo-project";
        return Response.json({
          projectId: project,
          projectName: project,
          status: "idle",
          counts: { total: 0, processed: 0, succeeded: 0, failed: 0 },
          items: [],
        });
      }

      if (url.startsWith("/api/workspace/summary?project=")) {
        const project = new URL(`http://localhost${url}`).searchParams.get("project") ?? "demo-project";
        return Response.json({
          summary: {
            project,
            files: [],
            generatedArtifacts: [],
            activity: [],
          },
        });
      }

      if (url.startsWith("/api/workspace?action=tree&projectId=")) {
        return Response.json({ tree: [] });
      }

      if (url.startsWith("/api/brain/pages?project=")) {
        return Response.json({ pages: [] });
      }

      if (url.startsWith("/api/brain/list?project=")) {
        return Response.json([]);
      }

      if (url.startsWith("/api/chat/thread?project=")) {
        const project = new URL(`http://localhost${url}`).searchParams.get("project") ?? "demo-project";
        return Response.json({
          version: 1,
          project,
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/settings/file-preview-location") {
        return Response.json({ location: "workspace-pane" });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    const view = render(<ProjectPage />);
    const input = await screen.findByLabelText("Chat with your project");

    fireEvent.change(input, { target: { value: "history prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("history answer")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "stale demo draft" } });

    searchParamsValue = "name=alpha-project";
    view.rerender(<ProjectPage />);

    await waitFor(() => {
      expect(screen.getByLabelText("Chat with your project")).toHaveValue("alpha restored draft");
    });

    const switchedInput = screen.getByLabelText("Chat with your project");
    fireEvent.keyDown(switchedInput, { key: "ArrowUp" });
    expect(switchedInput).toHaveValue("history prompt");

    fireEvent.keyDown(switchedInput, { key: "ArrowDown" });
    expect(switchedInput).toHaveValue("alpha restored draft");
  });

  it("keeps fast typed project drafts available while prompt history navigation unwinds", async () => {
    const pendingAnimationFrames: FrameRequestCallback[] = [];
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        pendingAnimationFrames.push(callback);
        return pendingAnimationFrames.length;
      });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => {});

    window.localStorage.setItem(
      "scienceswarm.chat.draft.alpha-project",
      "alpha restored draft",
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/projects") {
        return Response.json({
          projects: [
            { id: "demo-project", slug: "demo-project", name: "Demo Project", status: "active" },
            { id: "alpha-project", slug: "alpha-project", name: "Alpha Project", status: "active" },
          ],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({
          response: "history answer",
          conversationId: "conv-history",
          messages: [],
        });
      }

      if (url.startsWith("/api/brain/status")) {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        const project = new URL(`http://localhost${url}`).searchParams.get("project") ?? "demo-project";
        return Response.json({ project, dueTasks: [], frontier: [] });
      }

      if (url.startsWith("/api/projects/") && url.endsWith("/import-summary")) {
        const project = url.split("/")[3] ?? "demo-project";
        return Response.json({ project, lastImport: null });
      }

      if (url.startsWith("/api/projects/") && !url.includes("/import-summary") && !url.includes("/import-state")) {
        const project = url.split("/")[3] ?? "demo-project";
        return Response.json({
          project: {
            id: project,
            name: project,
            path: `/tmp/${project}`,
          },
        });
      }

      if (url.startsWith("/api/projects/") && url.endsWith("/import-state")) {
        const project = url.split("/")[3] ?? "demo-project";
        return Response.json({
          projectId: project,
          projectName: project,
          status: "idle",
          counts: { total: 0, processed: 0, succeeded: 0, failed: 0 },
          items: [],
        });
      }

      if (url.startsWith("/api/workspace/summary?project=")) {
        const project = new URL(`http://localhost${url}`).searchParams.get("project") ?? "demo-project";
        return Response.json({
          summary: {
            project,
            files: [],
            generatedArtifacts: [],
            activity: [],
          },
        });
      }

      if (url.startsWith("/api/workspace?action=tree&projectId=")) {
        return Response.json({ tree: [] });
      }

      if (url.startsWith("/api/brain/pages?project=")) {
        return Response.json({ pages: [] });
      }

      if (url.startsWith("/api/brain/list?project=")) {
        return Response.json([]);
      }

      if (url.startsWith("/api/chat/thread?project=")) {
        const project = new URL(`http://localhost${url}`).searchParams.get("project") ?? "demo-project";
        return Response.json({
          version: 1,
          project,
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/settings/file-preview-location") {
        return Response.json({ location: "workspace-pane" });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);
    try {
      const view = render(<ProjectPage />);
      const input = await screen.findByLabelText("Chat with your project");

      fireEvent.change(input, { target: { value: "history prompt" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      expect(await screen.findByText("history answer")).toBeInTheDocument();

      searchParamsValue = "name=alpha-project";
      view.rerender(<ProjectPage />);

      await waitFor(() => {
        expect(screen.getByLabelText("Chat with your project")).toHaveValue("alpha restored draft");
      });

      const switchedInput = screen.getByLabelText("Chat with your project");
      fireEvent.change(switchedInput, { target: { value: "alpha restored draft plus fast typing" } });

      fireEvent.keyDown(switchedInput, { key: "ArrowUp" });
      expect(switchedInput).toHaveValue("history prompt");

      fireEvent.keyDown(switchedInput, { key: "ArrowDown" });
      expect(switchedInput).toHaveValue("alpha restored draft plus fast typing");

      expect(pendingAnimationFrames.length).toBeGreaterThan(0);
    } finally {
      requestAnimationFrameSpy.mockRestore();
      cancelAnimationFrameSpy.mockRestore();
    }
  });

  it("does not swallow ArrowUp or ArrowDown when prompt history is empty", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project" });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    const input = await screen.findByLabelText("Chat with your project");

    const arrowUpEvent = createEvent.keyDown(input, { key: "ArrowUp" });
    const arrowDownEvent = createEvent.keyDown(input, { key: "ArrowDown" });
    arrowUpEvent.preventDefault = vi.fn();
    arrowDownEvent.preventDefault = vi.fn();

    fireEvent(input, arrowUpEvent);
    fireEvent(input, arrowDownEvent);

    expect(arrowUpEvent.preventDefault).not.toHaveBeenCalled();
    expect(arrowDownEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("does not swallow ArrowDown before history navigation has started", async () => {
    let responseCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
          openclaw: "connected",
          openhands: "disconnected",
          openai: "configured",
          features: {
            chat: true,
            codeExecution: false,
            github: false,
            multiChannel: false,
            structuredCritique: false,
          },
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project" });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        responseCount += 1;
        return Response.json({
          response: `response-${responseCount}`,
          conversationId: "conv-demo",
          messages: [],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    const input = await screen.findByLabelText("Chat with your project");

    fireEvent.change(input, { target: { value: "first prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("response-1")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "draft prompt" } });

    const arrowDownEvent = createEvent.keyDown(input, { key: "ArrowDown" });
    arrowDownEvent.preventDefault = vi.fn();
    fireEvent(input, arrowDownEvent);

    expect(arrowDownEvent.preventDefault).not.toHaveBeenCalled();
    expect(input).toHaveValue("draft prompt");
  });

  it("renders chat messages as selectable text", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
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
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 0, backend: "filesystem" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project" });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: "conv-1",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              content: "Selectable assistant reply",
              timestamp: "2026-04-14T12:00:01.000Z",
            },
          ],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    const message = await screen.findByText("Selectable assistant reply");
    const selectableContainer = message.closest("[data-testid='chat-bubble']");

    expect(selectableContainer).not.toBeNull();
    expect(selectableContainer).toHaveClass("select-text");
    // Assistant bubbles intentionally do NOT carry data-chat-selectable — that
    // attribute drives a white ::selection highlight that would be invisible
    // on the white assistant bubble. See src/app/globals.css.
    expect(selectableContainer).not.toHaveAttribute("data-chat-selectable");
  });




  it("keeps the project chat thread after a full remount even when the server thread is empty", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
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
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({
          pageCount: 0,
          backend: "filesystem",
        });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project" });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          agent: { type: "openclaw", status: "connected" },
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "disconnected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        return Response.json({
          response: "Persisted answer",
          conversationId: "conv-demo",
          messages: [],
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    const expectUserMessage = () => {
      expect(
        screen
          .getAllByText("hi")
          .some((element) => element.tagName.toLowerCase() !== "textarea"),
      ).toBe(true);
    };

    const firstRender = render(<ProjectPage />);

    expect(await screen.findByText(/Research workspace ready for/i)).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText("Chat with your project"),
      { target: { value: "hi" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Persisted answer")).toBeInTheDocument();
    expectUserMessage();

    firstRender.unmount();

    render(<ProjectPage />);

    expect(await screen.findByText("Persisted answer")).toBeInTheDocument();
    expectUserMessage();
  });



  it("treats a successful null import summary as empty and clears stale cache", async () => {
    window.localStorage.setItem(
      "scienceswarm.project.importSummary.demo-project",
      JSON.stringify({
        project: "demo-project",
        lastImport: {
          name: "Stale Cached Archive",
          preparedFiles: 4,
          detectedItems: 7,
          detectedBytes: 2048000,
          duplicateGroups: 2,
          generatedAt: "2026-04-11T09:30:00.000Z",
          source: "local-import",
        },
      }),
    );

    vi.stubGlobal(
      "fetch",
      stubDashboardFetch({
        importSummary: null,
      }),
    );

    render(<ProjectPage />);

    expect(await screen.findByText(/Research workspace ready for/i)).toBeInTheDocument();
    expect(screen.queryByText("Latest import: Stale Cached Archive")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("scienceswarm.project.importSummary.demo-project")).toBeNull();
  });

  it("skips the import-summary API for invalid project slugs", async () => {
    searchParamsValue = "name=bad/slug";

    const fetchMock = vi.fn((url: string) => {
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
        return Promise.resolve(
          Response.json({
            pageCount: 0,
            backend: "filesystem",
          }),
        );
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Promise.resolve(
          Response.json({
            project: "bad/slug",
            nextMove: {
              recommendation: "Review the imported sequencing notes before asking for a summary.",
            },
            dueTasks: [],
            frontier: [],
          }),
        );
      }

      if (url.includes("/api/projects/")) {
        throw new Error(`unexpected import-summary fetch: ${url}`);
      }

      return Promise.resolve(Response.json({ status: "disconnected" }));
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        typeof url === "string" && url.includes("/api/projects/"),
      ),
    ).toBe(false);
  });


  it("auto-opens project import onboarding when the brain is already ready", async () => {
    searchParamsValue = "name=demo-project&onboarding=1";
    vi.stubGlobal("fetch", stubDashboardFetch());

    render(<ProjectPage />);

    expect(await screen.findByRole("heading", { name: "Import Local Folder" })).toBeInTheDocument();

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/dashboard/project?name=demo-project");
    });
  });

  it("does not auto-open import onboarding when the brain status check errors", async () => {
    searchParamsValue = "name=demo-project&onboarding=1";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
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

        if (url === "/api/brain/status") {
          return Promise.reject(new Error("status check exploded"));
        }

        if (url.startsWith("/api/brain/brief?project=")) {
          return Promise.resolve(Response.json({ project: "demo-project" }));
        }

        return Promise.resolve(Response.json({ status: "disconnected" }));
      }),
    );

    render(<ProjectPage />);

    await screen.findByText(/Research workspace ready for/i);
    expect(screen.queryByRole("heading", { name: "Import Local Folder" })).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("routes explicit note captures through /api/brain/capture", async () => {
    let brainStatusCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
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
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        brainStatusCalls += 1;
        return Response.json({
          pageCount: brainStatusCalls > 1 ? 1 : 0,
          backend: "filesystem",
        });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/brain/capture" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          content: "signal drift fixed by fresh batch",
          kind: "note",
          channel: "web",
          project: "demo-project",
        });

        return Response.json({
          captureId: "capture-1",
          channel: "web",
          userId: "web-user-1",
          kind: "note",
          project: "demo-project",
          privacy: "cloud-ok",
          rawPath: "raw/captures/web/2026-04-13/capture-1.json",
          materializedPath: "wiki/resources/2026-04-13-signal-drift-fixed.md",
          requiresClarification: false,
          choices: [],
          status: "saved",
          createdAt: "2026-04-13T16:00:00.000Z",
          extractedTasks: [],
        });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        throw new Error("unexpected unified chat send");
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    expect(await screen.findByText(/Research workspace ready for/i)).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText("Chat with your project"),
      { target: { value: "note: signal drift fixed by fresh batch" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Brain capture saved/i)).toBeInTheDocument();
    expect(screen.getByText(/Project: demo-project/i)).toBeInTheDocument();
    expect(screen.getByText(/wiki\/resources\/2026-04-13-signal-drift-fixed\.md/i)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input, init]) =>
        String(input) === "/api/chat/unified" && (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);
  });

  it("routes research packet captures through /api/brain/capture with the research-native label", async () => {
    let brainStatusCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
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
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        brainStatusCalls += 1;
        return Response.json({
          pageCount: brainStatusCalls > 1 ? 1 : 0,
          backend: "filesystem",
        });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/demo-project/import-summary") {
        return Response.json({ project: "demo-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=demo-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=demo-project") {
        return Response.json({
          version: 1,
          project: "demo-project",
          conversationId: null,
          messages: [],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/brain/capture" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          content: "retained 12 exact-title matches after dedupe",
          kind: "research_packet",
          channel: "web",
          project: "demo-project",
        });

        return Response.json({
          captureId: "capture-packet",
          channel: "web",
          userId: "web-user-1",
          kind: "research_packet",
          project: "demo-project",
          privacy: "cloud-ok",
          rawPath: "raw/captures/web/2026-04-13/capture-packet.json",
          materializedPath: "wiki/packets/2026-04-13-retained-12-exact-title-matches.md",
          requiresClarification: false,
          choices: [],
          status: "saved",
          createdAt: "2026-04-13T16:00:00.000Z",
          extractedTasks: [],
        });
      }

      if (url === "/api/chat/unified" && method === "POST") {
        throw new Error("unexpected unified chat send");
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    expect(await screen.findByText(/Research workspace ready for/i)).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText("Chat with your project"),
      { target: { value: "packet: retained 12 exact-title matches after dedupe" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/Brain capture saved/i)).toBeInTheDocument();
    expect(screen.getByText(/Kind: Research packet/i)).toBeInTheDocument();
    expect(screen.getByText(/wiki\/packets\/2026-04-13-retained-12-exact-title-matches\.md/i)).toBeInTheDocument();
  });

  it("renders inline project choices for ambiguous web captures and resolves them", async () => {
    searchParamsValue = "";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
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
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({
          pageCount: 0,
          backend: "filesystem",
        });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "my-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/my-project/import-summary") {
        return Response.json({ project: "my-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=my-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=my-project") {
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

      if (url === "/api/brain/capture" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body.project).toBeNull();

        return Response.json({
          captureId: "capture-ambiguous",
          channel: "web",
          userId: "web-user-1",
          kind: "note",
          project: null,
          privacy: "cloud-ok",
          rawPath: "raw/captures/web/2026-04-13/capture-ambiguous.json",
          requiresClarification: true,
          clarificationQuestion: "Which project should this capture belong to?",
          choices: ["alpha", "beta"],
          status: "needs-clarification",
          createdAt: "2026-04-13T16:05:00.000Z",
        });
      }

      if (url === "/api/brain/capture/resolve" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          captureId: "capture-ambiguous",
          project: "alpha",
          rawPath: "raw/captures/web/2026-04-13/capture-ambiguous.json",
        });

        return Response.json({
          captureId: "capture-ambiguous",
          channel: "web",
          userId: "web-user-1",
          kind: "note",
          project: "alpha",
          privacy: "cloud-ok",
          rawPath: "raw/captures/web/2026-04-13/capture-ambiguous.json",
          materializedPath: "wiki/resources/2026-04-13-signal-drift-fixed.md",
          requiresClarification: false,
          choices: [],
          status: "saved",
          createdAt: "2026-04-13T16:05:05.000Z",
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    expect(await screen.findByText("No project selected")).toBeInTheDocument();

    fireEvent.change(
      screen.getByLabelText("Chat with your project"),
      { target: { value: "note: signal drift fixed by fresh batch" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("button", { name: "alpha" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "alpha" }));

    expect(await screen.findByText(/Project: alpha/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "beta" })).not.toBeInTheDocument();
    });
  });

  it("restores saved capture clarification choices from the persisted thread", async () => {
    searchParamsValue = "name=my-project";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";

      if (url === "/api/health") {
        return Response.json({
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
        });
      }

      if (url === "/api/chat/unified?action=health") {
        return Response.json({
          openclaw: "connected",
          nanoclaw: "disconnected",
          openhands: "connected",
          llmProvider: "openai",
          ollamaModels: [],
          configuredLocalModel: null,
        });
      }

      if (url === "/api/brain/status") {
        return Response.json({
          pageCount: 0,
          backend: "filesystem",
        });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "my-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/projects/my-project/import-summary") {
        return Response.json({ project: "my-project", lastImport: null });
      }

      if (url === "/api/workspace?action=tree&projectId=my-project") {
        return Response.json({ tree: [] });
      }

      if (url === "/api/chat/thread?project=my-project") {
        return Response.json({
          version: 1,
          project: "my-project",
          conversationId: null,
          messages: [
            {
              id: "assistant-clarification",
              role: "assistant",
              content: [
                "**Brain capture saved unlinked**",
                "Title: signal drift fixed by fresh batch",
                "Kind: Note",
                "Project: unlinked",
                "Path: raw/captures/web/2026-04-13/capture-ambiguous.json",
                "Which project should this capture belong to?",
              ].join("\n"),
              timestamp: "2026-04-13T16:05:00.000Z",
              captureClarification: {
                captureId: "capture-ambiguous",
                rawPath: "raw/captures/web/2026-04-13/capture-ambiguous.json",
                question: "Which project should this capture belong to?",
                choices: ["alpha", "beta"],
                capturedContent: "signal drift fixed by fresh batch",
              },
            },
          ],
        });
      }

      if (url === "/api/chat/thread" && method === "POST") {
        return Response.json({ ok: true });
      }

      if (url === "/api/brain/capture/resolve" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          captureId: "capture-ambiguous",
          project: "alpha",
          rawPath: "raw/captures/web/2026-04-13/capture-ambiguous.json",
        });

        return Response.json({
          captureId: "capture-ambiguous",
          channel: "web",
          userId: "web-user-1",
          kind: "note",
          project: "alpha",
          privacy: "cloud-ok",
          rawPath: "raw/captures/web/2026-04-13/capture-ambiguous.json",
          materializedPath: "wiki/resources/2026-04-13-signal-drift-fixed.md",
          requiresClarification: false,
          choices: [],
          status: "saved",
          createdAt: "2026-04-13T16:05:05.000Z",
        });
      }

      return Response.json({ status: "disconnected" });
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectPage />);

    expect(await screen.findByRole("button", { name: "alpha" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "beta" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "alpha" }));

    expect(await screen.findByText(/Project: alpha/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "beta" })).not.toBeInTheDocument();
    });
  });
});
