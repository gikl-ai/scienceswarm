// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HOSTED_DESCARTES_RECOVERY_MESSAGE } from "@/lib/structured-critique-errors";
import { SUBMIT_BUTTON_LABEL } from "@/lib/reasoning-page-constants";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import StructuredCritiquePage from "@/app/dashboard/reasoning/page";

const STORAGE_KEY = "structured-critique-history.v1";
const POLL_TIMEOUT_MESSAGE =
  "Analysis is taking longer than expected. This run is still saved in Recent Reasoning Analyses so you can check back shortly.";
const QUEUED_POLL_TIMEOUT_MESSAGE =
  "ScienceSwarm's Cloud Reasoning queue has accepted this run but it has not started yet. This run is still saved in Recent Reasoning Analyses so you can check back shortly.";

function makeCompletedJob(overrides?: Record<string, unknown>) {
  return {
    id: "job-completed-1",
    status: "COMPLETED",
    pdf_filename: "paper.pdf",
    style_profile: "professional",
    saved_at: "2026-04-11T10:00:00.000Z",
    result: {
      title: "Audit for Synthetic Biology Draft",
      report_markdown: "# Full Report\nThe evidence chain breaks around the main causal claim.",
      author_feedback: {
        overall_summary: "The draft's main claim is promising but currently under-justified.",
        top_issues: [
          {
            title: "Missing controls section",
            summary: "The manuscript never explains why the central comparison is fair.",
          },
          {
            title: "Causal leap",
            summary: "The results are correlational, but the discussion states causation.",
          },
        ],
        section_feedback: [
          {
            section: "Methods",
            summary:
              "The methods section should explain the missing control and how the central comparison was constructed.",
            finding_ids: ["finding-1"],
          },
        ],
        questions_for_authors: [
          {
            question: "Can you explain why the central comparison is fair?",
            rationale:
              "The current draft relies on the comparison but does not defend it.",
            finding_ids: ["finding-1"],
          },
        ],
        references_feedback:
          "No reference problems were found in this synthetic fixture.",
      },
      findings: [
        {
          finding_id: "finding-1",
          severity: "error",
          description: "The main conclusion depends on an unstated premise.",
          evidence_quote: "Because the signal increases, the mechanism must be present.",
          suggested_fix: "State and defend the hidden premise directly.",
          argument_id: "ARG-001",
          flaw_type: "missing_assumption",
          impact: "The core claim is not yet justified by the described evidence.",
          confidence: 0.88,
          finding_kind: "critique",
        },
        {
          finding_id: "finding-2",
          severity: "warning",
          description: "The paper treats a correlational result as if it established causation.",
          evidence_quote: "This result demonstrates that the intervention causes the response.",
          suggested_fix: "Reframe the claim or add evidence that rules out alternative causes.",
          argument_id: "ARG-004",
          flaw_type: "causal_leap",
          impact: "The discussion currently overstates what the data can support.",
          confidence: 0.74,
          finding_kind: "fallacy",
        },
        {
          finding_id: "finding-3",
          severity: "note",
          description: "A plausible reviewer objection is mentioned but never addressed.",
          evidence_quote: "An alternative explanation could be measurement drift.",
          suggested_fix: "Either rebut the objection or narrow the scope of the conclusion.",
          argument_id: "ARG-007",
          flaw_type: "ignored_counterargument",
          impact: "Addressing the objection would improve reviewer trust in the argument.",
          confidence: 0.63,
          finding_kind: "gap",
        },
      ],
    },
    ...overrides,
  };
}

function makeZeroFindingJob() {
  return makeCompletedJob({
    result: {
      title: "Clean Draft",
      report_markdown: "# Clean Draft\nNo major issues detected.",
      author_feedback: {
        overall_summary: "The reasoning structure looks unusually clean.",
        top_issues: [],
      },
      findings: [],
    },
  });
}

function makePartialFailureJob() {
  return makeCompletedJob({
    id: "job-failed-1",
    status: "FAILED",
    error_message: "One stage timed out after partial completion.",
  });
}

function makeFullFailureJob() {
  return makeCompletedJob({
    id: "job-failed-empty",
    status: "FAILED",
    error_message: "Structured critique failed due to an internal pipeline error.",
    result: {
      title: "",
      report_markdown: "",
      author_feedback: null,
      findings: [],
    },
  });
}

function makeCancelledJob() {
  return {
    ...makeCompletedJob({
      id: "job-cancelled-empty",
      status: "CANCELLED",
      result: null,
    }),
    error_message:
      "This queued critique was cancelled after you reached the hosted output limit.",
  };
}

function makeHealthResponse(structuredCritique = true, detail?: string) {
  return Response.json({
    features: {
      structuredCritique,
    },
    structuredCritique: {
      ready: structuredCritique,
      detail:
        detail ??
        (structuredCritique
          ? "Cloud Descartes critique is ready."
          : "Live analysis requires `STRUCTURED_CRITIQUE_SERVICE_URL` and `STRUCTURED_CRITIQUE_SERVICE_TOKEN` for the hosted Descartes critique service. Restart the Next.js server after changing them."),
    },
  });
}

function makeAuthStatusResponse(
  overrides?: Partial<{
    detail: string;
    expiresAt: string | null;
    signedIn: boolean;
  }>,
) {
  return Response.json({
    detail:
      "Create a free account at scienceswarm.ai and sign in to use the Cloud Reasoning API.",
    expiresAt: null,
    signedIn: false,
    ...overrides,
  });
}

function isAuthStatusRequest(input: RequestInfo | URL): boolean {
  return String(input) === "/api/scienceswarm-auth/status";
}

function isPersistedCritiqueList(input: RequestInfo | URL): boolean {
  return String(input).startsWith("/api/brain/critique?limit=");
}

function makeEmptyPersistedCritiqueList() {
  return Response.json({ audits: [] });
}

function isHostedCritiqueHistoryRequest(input: RequestInfo | URL): boolean {
  return String(input).startsWith("/api/structured-critique?history=1&limit=");
}

function makeEmptyHostedCritiqueHistory() {
  return Response.json({ jobs: [] });
}

function isProjectListRequest(input: RequestInfo | URL): boolean {
  return String(input) === "/api/studies";
}

function makeProjectListResponse() {
  return Response.json({
    studies: [
      {
        slug: "project-alpha",
        name: "Project Alpha",
        description: "Example project",
      },
      {
        slug: "project-beta",
        name: "Project Beta",
        description: "Second example project",
      },
    ],
  });
}

async function openRecentAnalysis(label: string | RegExp) {
  if (!screen.queryByText(label)) {
    fireEvent.click(
      screen.getByRole("button", { name: /Recent Reasoning Analyses/i }),
    );
  }
  fireEvent.click(await screen.findByText(label));
}

describe("Critique workspace", () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.spyOn(window, "print").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/health") {
          return makeHealthResponse(true);
        }
        if (isAuthStatusRequest(input)) {
          return makeAuthStatusResponse();
        }
        if (isPersistedCritiqueList(input)) {
          return makeEmptyPersistedCritiqueList();
        }
        if (isHostedCritiqueHistoryRequest(input)) {
          return makeEmptyHostedCritiqueHistory();
        }
        if (isProjectListRequest(input)) {
          return makeProjectListResponse();
        }
        if (String(input) === "/api/brain/critique") {
          return Response.json({
            brain_slug: "paper-critique",
            url: "/dashboard/reasoning?brain_slug=paper-critique",
            project_url: "/dashboard/study?name=paper&brain_slug=paper-critique",
          });
        }
        throw new Error(`Unexpected fetch in test: ${String(input)}`);
      }),
    );
  });

  it("shows an empty guidance state on first visit", async () => {
    render(<StructuredCritiquePage />);

    expect(screen.getByText("Deep Reasoning API")).toBeInTheDocument();
    expect(
      await screen.findByText("Analyze a paper, memo, or argument for reasoning flaws."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Upload a PDF or paste text to deeply analyze the logic of a piece/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View example report" })).toBeInTheDocument();
    expect(screen.getByText("Choose a PDF")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("explains when strict local-only mode blocks hosted critique", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/health") {
          return makeHealthResponse(
            false,
            "Cloud Descartes critique is blocked in strict local-only mode.",
          );
        }
        if (isPersistedCritiqueList(input)) {
          return makeEmptyPersistedCritiqueList();
        }
        if (isHostedCritiqueHistoryRequest(input)) {
          return makeEmptyHostedCritiqueHistory();
        }
        if (String(input) === "/api/brain/critique") {
          return Response.json({
            brain_slug: "paper-critique",
            url: "/dashboard/reasoning?brain_slug=paper-critique",
            project_url: "/dashboard/study?name=paper&brain_slug=paper-critique",
          });
        }
        throw new Error(`Unexpected fetch in test: ${String(input)}`);
      }),
    );

    render(<StructuredCritiquePage />);

    expect(
      await screen.findByText("Cloud Descartes critique is blocked in strict local-only mode."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Live analysis requires `STRUCTURED_CRITIQUE_SERVICE_URL`/),
    ).not.toBeInTheDocument();
  });

  it("lists saved gbrain audits without opening one until the user chooses it", async () => {
    const newestResult = {
      ...makeCompletedJob().result,
      title: "Newest saved text audit",
      author_feedback: {
        overall_summary: "The newest text-only audit should open first.",
        top_issues: [
          {
            title: "Newest saved text audit",
            summary: "This audit has no source filename but is newest.",
          },
        ],
      },
    };
    const olderPdfResult = {
      ...makeCompletedJob().result,
      title: "Older PDF audit",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/health") {
          return makeHealthResponse(true);
        }
        if (isAuthStatusRequest(input)) {
          return makeAuthStatusResponse();
        }
        if (isPersistedCritiqueList(input)) {
          return Response.json({
            audits: [
              {
                brain_slug: "newest-text-critique",
                parent_slug: "pasted-text",
                project_slug: "pasted-text",
                title: "Newest text critique",
                uploaded_at: "2026-04-18T08:02:34.000Z",
                descartes_job_id: "job-newest-text",
                finding_count: 3,
                url: "/dashboard/reasoning?brain_slug=newest-text-critique",
                project_url:
                  "/dashboard/study?name=pasted-text&brain_slug=newest-text-critique",
              },
              {
                brain_slug: "hubble-1929-critique",
                parent_slug: "hubble-1929",
                project_slug: "hubble-1929",
                title: "Hubble critique",
                uploaded_at: "2026-04-18T07:02:34.000Z",
                source_filename: "hubble-1929.pdf",
                descartes_job_id: "job-hubble",
                finding_count: 3,
                url: "/dashboard/reasoning?brain_slug=hubble-1929-critique",
                project_url:
                  "/dashboard/study?name=hubble-1929&brain_slug=hubble-1929-critique",
              },
            ],
          });
        }
        if (isHostedCritiqueHistoryRequest(input)) {
          return makeEmptyHostedCritiqueHistory();
        }
        if (url === "/api/brain/page?slug=newest-text-critique") {
          return Response.json({
            slug: "newest-text-critique",
            title: "Newest text critique",
            type: "note",
            frontmatter: {
              type: "critique",
              parent: "pasted-text",
              project: "pasted-text",
              style_profile: "professional",
            },
            content: `# Newest text critique\n\n\`\`\`json\n${JSON.stringify(newestResult)}\n\`\`\``,
          });
        }
        if (url === "/api/brain/page?slug=hubble-1929-critique") {
          return Response.json({
            slug: "hubble-1929-critique",
            title: "Hubble critique",
            type: "note",
            frontmatter: {
              type: "critique",
              parent: "hubble-1929",
              project: "hubble-1929",
              source_filename: "hubble-1929.pdf",
              style_profile: "professional",
            },
            content: `# Hubble critique\n\n\`\`\`json\n${JSON.stringify(olderPdfResult)}\n\`\`\``,
          });
        }
        throw new Error(`Unexpected fetch in test: ${url}`);
      }),
    );

    render(<StructuredCritiquePage />);

    expect(
      await screen.findByText("Analyze a paper, memo, or argument for reasoning flaws."),
    ).toBeInTheDocument();
    expect(await screen.findByText("Newest text critique")).toBeInTheDocument();
    expect(screen.getByText("hubble-1929.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Newest saved text audit")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Newest text critique"));

    expect(
      await screen.findByText("Newest saved text audit"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Older PDF audit")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Analyze a paper, memo, or argument for reasoning flaws."),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Saved in pasted-text")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in file tree" })).toHaveAttribute(
      "href",
      "/dashboard/study?name=pasted-text&brain_slug=newest-text-critique",
    );
    expect(screen.getByText("Saved in brain")).toBeInTheDocument();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("does not render saved gbrain pages as browser run replicas", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        makeCompletedJob({
          id: "brain:hubble-1929-critique",
          pdf_filename: "hubble-1929.pdf",
          saved_at: "2026-04-18T07:02:34.000Z",
        }),
      ]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/health") {
          return makeHealthResponse(true);
        }
        if (isAuthStatusRequest(input)) {
          return makeAuthStatusResponse();
        }
        if (isPersistedCritiqueList(input)) {
          return Response.json({
            audits: [
              {
                brain_slug: "hubble-1929-critique",
                parent_slug: "hubble-1929",
                project_slug: "hubble-1929",
                title: "Hubble critique",
                uploaded_at: "2026-04-18T07:02:34.000Z",
                source_filename: "hubble-1929.pdf",
                descartes_job_id: "job-hubble",
                finding_count: 3,
                url: "/dashboard/reasoning?brain_slug=hubble-1929-critique",
                project_url:
                  "/dashboard/study?name=hubble-1929&brain_slug=hubble-1929-critique",
              },
            ],
          });
        }
        if (isHostedCritiqueHistoryRequest(input)) {
          return makeEmptyHostedCritiqueHistory();
        }
        throw new Error(`Unexpected fetch in test: ${url}`);
      }),
    );

    render(<StructuredCritiquePage />);

    expect(await screen.findByText("Saved in brain")).toBeInTheDocument();
    expect(screen.queryByText("Run history")).not.toBeInTheDocument();
    expect(screen.getAllByText("hubble-1929.pdf")).toHaveLength(1);
  });

  it("rehydrates hosted history when browser-local history is empty", async () => {
    const remoteJob = {
      ...makeCompletedJob(),
      id: "job-remote-1",
      pdf_filename: "remote-paper.pdf",
      created_at: "2026-04-20T16:26:03.000Z",
      completed_at: "2026-04-20T16:36:59.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse({ signedIn: true });
      }
      if (isPersistedCritiqueList(input)) {
        return makeEmptyPersistedCritiqueList();
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return Response.json({ jobs: [remoteJob] });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<StructuredCritiquePage />);

    expect(
      await screen.findByText("Analyze a paper, memo, or argument for reasoning flaws."),
    ).toBeInTheDocument();
    expect(await screen.findByText("remote-paper.pdf")).toBeInTheDocument();
    fireEvent.click(screen.getByText("remote-paper.pdf"));

    expect(await screen.findByText("Audit for Synthetic Biology Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to study..." })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/brain/critique",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("renders the issue-driven workspace for a completed job", async () => {
    const completedJob = makeCompletedJob();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([completedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    expect(await screen.findByText("Audit for Synthetic Biology Draft")).toBeInTheDocument();
    expect(screen.getByText("3 findings")).toBeInTheDocument();
    expect(screen.getByText(/1 error · 1 warning · 1 note/)).toBeInTheDocument();
    expect(screen.getByText("1. Missing controls section")).toBeInTheDocument();
    expect(screen.getByText("2. Causal leap")).toBeInTheDocument();
    expect(screen.getByText("Summary")).toBeInTheDocument();
    expect(
      screen.getAllByText("The draft's main claim is promising but currently under-justified.").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Section-by-section feedback")).toBeInTheDocument();
    expect(screen.getByText("Methods")).toBeInTheDocument();
    expect(
      screen.getByText(/The methods section should explain the missing control/),
    ).toBeInTheDocument();
    expect(screen.getByText("Questions for authors")).toBeInTheDocument();
    expect(
      screen.getByText("Can you explain why the central comparison is fair?"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("The main conclusion depends on an unstated premise.").length,
    ).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByText("Report markdown"));

    expect(screen.getByText(/The evidence chain breaks around the main causal claim/)).toBeInTheDocument();
  });

  it("saves a completed audit to selected projects", async () => {
    const completedJob = makeCompletedJob();
    const postBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse();
      }
      if (isPersistedCritiqueList(input)) {
        return makeEmptyPersistedCritiqueList();
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return makeEmptyHostedCritiqueHistory();
      }
      if (isProjectListRequest(input)) {
        return makeProjectListResponse();
      }
      if (String(input) === "/api/brain/critique") {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        postBodies.push(body);
        return Response.json({
          brain_slug: "paper-critique",
          project_slug: "project-alpha",
          project_slugs: ["project-alpha"],
          url: "/dashboard/reasoning?brain_slug=paper-critique",
          project_url: "/dashboard/study?name=project-alpha&brain_slug=paper-critique",
          project_urls: {
            "project-alpha":
              "/dashboard/study?name=project-alpha&brain_slug=paper-critique",
          },
        });
      }
      throw new Error(`Unexpected fetch in test: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([completedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    expect(await screen.findByText("Audit for Synthetic Biology Draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save to study..." })).toBeInTheDocument();
    expect(postBodies).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save to study..." }));
    expect(await screen.findByText("Destination studies")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Project Alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Save critique" }));

    expect(await screen.findByText("Saved in Project Alpha")).toBeInTheDocument();
    expect(postBodies).toMatchObject([
      {
        job: { id: "job-completed-1" },
        sourceFilename: "paper.pdf",
        projectSlugs: ["project-alpha"],
      },
    ]);
    expect(screen.getByRole("link", { name: "Open in file tree" })).toHaveAttribute(
      "href",
      "/dashboard/study?name=project-alpha&brain_slug=paper-critique",
    );
    expect(screen.getByRole("link", { name: "Open saved analysis" })).toHaveAttribute(
      "href",
      "/dashboard/reasoning?brain_slug=paper-critique",
    );
  });

  it("shows save API failures inside the project picker", async () => {
    const completedJob = makeCompletedJob();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse();
      }
      if (isPersistedCritiqueList(input)) {
        return makeEmptyPersistedCritiqueList();
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return makeEmptyHostedCritiqueHistory();
      }
      if (isProjectListRequest(input)) {
        return makeProjectListResponse();
      }
      if (String(input) === "/api/brain/critique") {
        return Response.json({ error: "gbrain unavailable" }, { status: 503 });
      }
      throw new Error(`Unexpected fetch in test: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([completedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");
    fireEvent.click(await screen.findByRole("button", { name: "Save to study..." }));
    fireEvent.click(await screen.findByText("Project Alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Save critique" }));

    const destinationLabel = await screen.findByText("Destination studies");
    const panel = destinationLabel.parentElement?.parentElement;
    expect(panel).toBeTruthy();
    expect(
      await within(panel as HTMLElement).findByText("gbrain unavailable"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("gbrain unavailable")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save critique" })).toBeEnabled();
  });

  it("resets project creation state when reopening the save picker", async () => {
    const completedJob = makeCompletedJob();
    let resolveCreateProject!: (response: Response) => void;
    const pendingCreateProject = new Promise<Response>((resolve) => {
      resolveCreateProject = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse();
      }
      if (isPersistedCritiqueList(input)) {
        return makeEmptyPersistedCritiqueList();
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return makeEmptyHostedCritiqueHistory();
      }
      if (String(input) === "/api/studies" && init?.method === "POST") {
        return pendingCreateProject;
      }
      if (isProjectListRequest(input)) {
        return makeProjectListResponse();
      }
      if (String(input) === "/api/brain/critique") {
        return Response.json({
          brain_slug: "paper-critique",
          project_slug: "project-alpha",
          project_slugs: ["project-alpha"],
          url: "/dashboard/reasoning?brain_slug=paper-critique",
        });
      }
      throw new Error(`Unexpected fetch in test: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([completedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");
    fireEvent.click(await screen.findByRole("button", { name: "Save to study..." }));
    fireEvent.change(await screen.findByPlaceholderText("Study name"), {
      target: { value: "New Project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save critique" }));
    expect(await screen.findByRole("button", { name: "Saving..." })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Save to study..." }));
    fireEvent.click(await screen.findByText("Project Alpha"));

    expect(screen.getByRole("button", { name: "Save critique" })).toBeEnabled();

    await act(async () => {
      resolveCreateProject(Response.json({
        project: {
          slug: "new-project",
          name: "New Project",
          description: "",
        },
      }));
    });
  });

  it("recognizes a local completed audit that was already saved", async () => {
    const completedJob = makeCompletedJob();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse();
      }
      if (isPersistedCritiqueList(input)) {
        return Response.json({
          audits: [
            {
              brain_slug: "paper-critique",
              project_slug: "project-alpha",
              project_slugs: ["project-alpha"],
              title: "Audit for Synthetic Biology Draft",
              uploaded_at: "2026-04-11T11:00:00.000Z",
              source_filename: "paper.pdf",
              descartes_job_id: "job-completed-1",
              finding_count: 3,
              url: "/dashboard/reasoning?brain_slug=paper-critique",
              project_url:
                "/dashboard/study?name=project-alpha&brain_slug=paper-critique",
            },
          ],
        });
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return makeEmptyHostedCritiqueHistory();
      }
      if (String(input) === "/api/brain/critique") {
        throw new Error(`Unexpected save request: ${String(init?.body)}`);
      }
      throw new Error(`Unexpected fetch in test: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([completedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    expect(await screen.findByText("Audit for Synthetic Biology Draft")).toBeInTheDocument();
    expect(await screen.findByText("Saved in project-alpha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in file tree" })).toHaveAttribute(
      "href",
      "/dashboard/study?name=project-alpha&brain_slug=paper-critique",
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/brain/critique",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("filters the issue queue by flaw type", async () => {
    const completedJob = makeCompletedJob();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([completedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    expect((await screen.findAllByText("missing_assumption")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole("button", { name: "Fallacy" })).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Filter issue queue by Causal Leap \(1 finding\)/,
      }),
    );

    expect((await screen.findAllByText("causal_leap")).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByText("missing_assumption")).toHaveLength(0);
    expect(screen.queryAllByText("ignored_counterargument")).toHaveLength(0);
    expect(
      screen.getAllByText("The paper treats a correlational result as if it established causation.").length,
    ).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: "All 3" }));
    expect((await screen.findAllByText("missing_assumption")).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces useful details for the selected issue", async () => {
    const completedJob = makeCompletedJob();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([completedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    expect(await screen.findByRole("heading", { name: "Missing Assumption" })).toBeInTheDocument();
    expect(screen.getByText("What is wrong")).toBeInTheDocument();
    expect(screen.getByText("Evidence quoted")).toBeInTheDocument();
    expect(screen.getByText("Why it matters")).toBeInTheDocument();
    expect(screen.getByText("Suggested fix")).toBeInTheDocument();
    expect(
      screen.getAllByText("The core claim is not yet justified by the described evidence.").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("does not show the structured-critique feedback harness in the workspace", async () => {
    const completedJob = makeCompletedJob();
    const feedbackRequests: RequestInit[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse();
      }
      if (isPersistedCritiqueList(input)) {
        return makeEmptyPersistedCritiqueList();
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return makeEmptyHostedCritiqueHistory();
      }
      if (String(input) === "/api/brain/critique") {
        return Response.json({
          brain_slug: "paper-critique",
          url: "/dashboard/reasoning?brain_slug=paper-critique",
          project_url: "/dashboard/study?name=paper&brain_slug=paper-critique",
        });
      }
      if (String(input) === "/api/structured-critique/feedback") {
        feedbackRequests.push(init as RequestInit);
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([completedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    await screen.findByText("Audit for Synthetic Biology Draft");

    expect(screen.queryByTitle("Useful")).not.toBeInTheDocument();
    expect(screen.queryByTitle("Not useful")).not.toBeInTheDocument();
    expect(screen.queryByText("Would you revise?")).not.toBeInTheDocument();
    expect(screen.queryByText("Choose the remaining answer to send feedback.")).not.toBeInTheDocument();
    expect(feedbackRequests).toHaveLength(0);
  });

  it("shows a warning and available findings on partial failure", async () => {
    const failedJob = makePartialFailureJob();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([failedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    expect(await screen.findByText(/Analysis partially completed\./)).toBeInTheDocument();
    expect(screen.getByText("Audit for Synthetic Biology Draft")).toBeInTheDocument();
    expect(
      screen.getAllByText("The main conclusion depends on an unstated premise.").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("shows hosted Descartes recovery guidance on generic full failure", async () => {
    const failedJob = makeFullFailureJob();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([failedJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    expect(await screen.findByText(HOSTED_DESCARTES_RECOVERY_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows cancelled-job errors instead of treating them as invalid responses", async () => {
    const cancelledJob = makeCancelledJob();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([cancelledJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    expect(
      await screen.findByText(cancelledJob.error_message as string),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows the zero-findings recovery suggestion", async () => {
    const zeroFindingJob = makeZeroFindingJob();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([zeroFindingJob]));

    render(<StructuredCritiquePage />);

    await openRecentAnalysis("paper.pdf");

    expect(await screen.findByText("No reasoning flaws detected in this document.")).toBeInTheDocument();
    expect(
      screen.getByText(/Try re-running with a longer passage or the full document/),
    ).toBeInTheDocument();
  });

  it("submits text analyses without exposing or sending a fake domain selector", async () => {
    let resolveSubmission!: (response: Response) => void;
    let submittedForm: FormData | null = null;
    const pendingSubmission = new Promise<Response>((resolve) => {
      resolveSubmission = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse({ signedIn: true });
      }
      if (isPersistedCritiqueList(input)) {
        return makeEmptyPersistedCritiqueList();
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return makeEmptyHostedCritiqueHistory();
      }
      if (url === "/api/structured-critique") {
        submittedForm = init?.body instanceof FormData ? init.body : null;
        return pendingSubmission;
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<StructuredCritiquePage />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByPlaceholderText(/deeply analyzed/), {
      target: {
        value:
          "This manuscript argues that a single intervention explains the full observed effect. "
            .repeat(4),
      },
    });
    const analyzeButton = await screen.findByRole("button", {
      name: SUBMIT_BUTTON_LABEL,
    });
    await waitFor(() => {
      expect(analyzeButton).toBeEnabled();
    });
    fireEvent.click(analyzeButton);

    expect(
      await screen.findByText(/Analyzing your document for reasoning flaws/),
    ).toBeInTheDocument();
    const getSubmittedForm = (): FormData | null => submittedForm;
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(getSubmittedForm()?.get("fallacy_profile")).toBeNull();

    resolveSubmission(Response.json(makeCompletedJob({
      id: "job-auto-domain",
      pdf_filename: "pasted-text.txt",
    })));
    expect(await screen.findByRole("button", { name: "Save to study..." })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/brain/critique",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("enables the reasoning-engine submit button for a single-sentence pasted text submission", async () => {
    let submittedForm: FormData | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse({ signedIn: true });
      }
      if (isPersistedCritiqueList(input)) {
        return makeEmptyPersistedCritiqueList();
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return makeEmptyHostedCritiqueHistory();
      }
      if (url === "/api/structured-critique") {
        submittedForm = init?.body instanceof FormData ? init.body : null;
        return Response.json(makeCompletedJob({
          id: "job-short-text",
          pdf_filename: "pasted-text.txt",
        }));
      }
      if (url === "/api/brain/critique") {
        return Response.json({
          brain_slug: "short-text-critique",
          url: "/dashboard/reasoning?brain_slug=short-text-critique",
          project_url: "/dashboard/study?name=short-text&brain_slug=short-text-critique",
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<StructuredCritiquePage />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByPlaceholderText(/deeply analyzed/), {
      target: {
        value:
          "Digital infrastructure expansion is essential for modern progress because it compounds later scientific and industrial improvements.",
      },
    });

    const analyzeButton = await screen.findByRole("button", {
      name: SUBMIT_BUTTON_LABEL,
    });
    await waitFor(() => {
      expect(analyzeButton).toBeEnabled();
    });

    fireEvent.click(analyzeButton);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/structured-critique",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const getSubmittedForm = (): FormData | null => submittedForm;
    expect(getSubmittedForm()).toBeInstanceOf(FormData);
    const form = getSubmittedForm();
    if (!form) {
      throw new Error("Expected the short-text submission to send FormData.");
    }
    expect(form.get("text")).toBe(
      "Digital infrastructure expansion is essential for modern progress because it compounds later scientific and industrial improvements.",
    );
  });

  it("lets the user open an audit from recent history", async () => {
    const newerBase = makeCompletedJob();
    const newerJob = {
      ...newerBase,
      id: "job-newer",
      pdf_filename: "newer.pdf",
      saved_at: "2026-04-11T12:00:00.000Z",
      result: {
        ...newerBase.result,
        title: "Newer Audit",
      },
    };
    const olderBase = makeCompletedJob();
    const olderJob = {
      ...olderBase,
      id: "job-older",
      pdf_filename: "older.pdf",
      saved_at: "2026-04-10T12:00:00.000Z",
      result: {
        ...olderBase.result,
        title: "Older Audit",
      },
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([olderJob, newerJob]));

    render(<StructuredCritiquePage />);

    expect(
      await screen.findByText("Analyze a paper, memo, or argument for reasoning flaws."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Recent Reasoning Analyses/i }));
    fireEvent.click(await screen.findByText("newer.pdf"));

    expect(await screen.findByText("Newer Audit")).toBeInTheDocument();

    fireEvent.click(screen.getByText("older.pdf"));

    expect(await screen.findByText("Older Audit")).toBeInTheDocument();
  });

  it("shows a long-running fallback and can resume polling later", async () => {
    const recoveredJob = {
      id: "job-timeout-1",
      status: "COMPLETED",
      pdf_filename: "long-running.txt",
      style_profile: "professional",
      result: {
        ...makeCompletedJob().result,
        title: "Recovered Audit",
      },
    };
    let pollCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse({ signedIn: true });
      }
      if (isPersistedCritiqueList(input)) {
        return makeEmptyPersistedCritiqueList();
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return makeEmptyHostedCritiqueHistory();
      }
      if (url === "/api/brain/critique") {
        return Response.json({
          brain_slug: "long-running-critique",
          url: "/dashboard/reasoning?brain_slug=long-running-critique",
          project_url:
            "/dashboard/study?name=long-running&brain_slug=long-running-critique",
        });
      }
      if (url === "/api/structured-critique") {
        return Response.json(
          {
            id: "job-timeout-1",
            status: "PENDING",
            pdf_filename: "long-running.txt",
            style_profile: "professional",
          },
          { status: 202 },
        );
      }

      pollCalls += 1;
      if (pollCalls <= 120) {
        return Response.json({
          id: "job-timeout-1",
          status: "RUNNING",
          pdf_filename: "long-running.txt",
          style_profile: "professional",
        });
      }

      return Response.json(recoveredJob);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "setTimeout").mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0;
    }) as typeof window.setTimeout);
    vi.spyOn(window, "setInterval").mockImplementation(
      () => 0 as unknown as ReturnType<typeof window.setInterval>,
    );

    render(<StructuredCritiquePage />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByPlaceholderText(/deeply analyzed/), {
      target: {
        value:
          "This manuscript argues that a single intervention explains the full observed effect. "
            .repeat(4),
      },
    });
    await act(async () => {
      for (let i = 0; i < 40; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SUBMIT_BUTTON_LABEL }));
      for (let i = 0; i < 600; i += 1) {
        await Promise.resolve();
      }
    });

    expect(screen.getByText(POLL_TIMEOUT_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume polling" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume polling" }));
      for (let i = 0; i < 40; i += 1) {
        await Promise.resolve();
      }
    });

    expect(screen.getByText("Recovered Audit")).toBeInTheDocument();
  });

  it("surfaces Cloud Reasoning queue progress honestly while a run is waiting", async () => {
    const recoveredJob = {
      id: "job-queued-1",
      status: "COMPLETED",
      pdf_filename: "queued.txt",
      style_profile: "professional",
      result: {
        ...makeCompletedJob().result,
        title: "Queued Audit Recovered",
      },
    };
    let pollCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/health") {
        return makeHealthResponse(true);
      }
      if (isAuthStatusRequest(input)) {
        return makeAuthStatusResponse({ signedIn: true });
      }
      if (isPersistedCritiqueList(input)) {
        return makeEmptyPersistedCritiqueList();
      }
      if (isHostedCritiqueHistoryRequest(input)) {
        return makeEmptyHostedCritiqueHistory();
      }
      if (url === "/api/brain/critique") {
        return Response.json({
          brain_slug: "queued-critique",
          url: "/dashboard/reasoning?brain_slug=queued-critique",
          project_url:
            "/dashboard/study?name=queued&brain_slug=queued-critique",
        });
      }
      if (url === "/api/structured-critique") {
        return Response.json(
          {
            id: "job-queued-1",
            status: "PENDING",
            pdf_filename: "queued.txt",
            style_profile: "professional",
            progress_stage: "queued",
            progress_message: "High-compute paper analysis queued.",
          },
          { status: 202 },
        );
      }

      pollCalls += 1;
      if (pollCalls <= 120) {
        return Response.json({
          id: "job-queued-1",
          status: "RUNNING",
          pdf_filename: "queued.txt",
          style_profile: "professional",
          progress_stage: "queued",
          progress_message: "High-compute paper analysis queued.",
        });
      }

      return Response.json(recoveredJob);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "setTimeout").mockImplementation(((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0;
    }) as typeof window.setTimeout);
    vi.spyOn(window, "setInterval").mockImplementation(
      () => 0 as unknown as ReturnType<typeof window.setInterval>,
    );

    render(<StructuredCritiquePage />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByPlaceholderText(/deeply analyzed/), {
      target: {
        value:
          "This manuscript argues that a single intervention explains the full observed effect. "
            .repeat(4),
      },
    });
    await act(async () => {
      for (let i = 0; i < 40; i += 1) {
        await Promise.resolve();
      }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SUBMIT_BUTTON_LABEL }));
      for (let i = 0; i < 200; i += 1) {
        await Promise.resolve();
      }
    });

    expect(screen.getByText(QUEUED_POLL_TIMEOUT_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume polling" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume polling" }));
      for (let i = 0; i < 40; i += 1) {
        await Promise.resolve();
      }
    });

    expect(screen.getByText("Queued Audit Recovered")).toBeInTheDocument();
  });

  it("shows the hosted reasoning availability warning to signed-in users", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/health") {
          return makeHealthResponse(false);
        }
        if (isAuthStatusRequest(input)) {
          return makeAuthStatusResponse({ signedIn: true });
        }
        if (isPersistedCritiqueList(input)) {
          return makeEmptyPersistedCritiqueList();
        }
        if (isHostedCritiqueHistoryRequest(input)) {
          return makeEmptyHostedCritiqueHistory();
        }
        throw new Error(`Unexpected fetch in test: ${String(input)}`);
      }),
    );

    render(<StructuredCritiquePage />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByPlaceholderText(/deeply analyzed/), {
      target: {
        value:
          "This manuscript argues that a single intervention explains the full observed effect. "
            .repeat(4),
      },
    });

    expect(
      await screen.findByText(
        /ScienceSwarm reasoning is temporarily unavailable\. Try again in a few minutes\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SUBMIT_BUTTON_LABEL })).toBeDisabled();
  });
});
