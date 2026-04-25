// @vitest-environment jsdom

import type { AnchorHTMLAttributes, ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let searchParamsValue = "name=demo-project";
const replaceMock = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(searchParamsValue),
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

import GbrainPage from "@/app/dashboard/gbrain/page";

function buildWorkspaceSkill(input: {
  slug: string;
  name?: string;
  description?: string;
  rawMarkdown?: string;
  visibility?: "public" | "private";
  status?: "draft" | "ready";
  tags?: string[];
  summary?: string | null;
  syncState?: "synced" | "pending" | "no-target" | "missing-adapter";
}) {
  const slug = input.slug;
  return {
    slug,
    name: input.name ?? slug,
    description: input.description ?? `Description for ${slug}`,
    visibility: input.visibility ?? "private",
    status: input.status ?? "draft",
    tags: input.tags ?? [],
    hosts: ["openclaw"],
    owner: "scienceswarm",
    summary: input.summary ?? null,
    source: { kind: "local" },
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    adapters: [
      {
        host: "openclaw",
        relativePath: `skills/${slug}/hosts/openclaw/SKILL.md`,
        syncTargetPath: `.openclaw/skills/${slug}/SKILL.md`,
        syncState: input.syncState ?? "pending",
        rawMarkdown: input.rawMarkdown ?? `---
name: ${slug}
description: ${input.description ?? `Description for ${slug}`}
---

# ${input.name ?? slug}
`,
      },
    ],
  };
}

function buildInstalledMarketPlugin(input: {
  id: string;
  displayName?: string;
  description?: string;
  skillSlugs?: string[];
  status?: "installed" | "partial" | "missing";
}) {
  const status = input.status ?? "installed";
  return {
    id: input.id,
    name: input.id,
    displayName: input.displayName ?? input.id,
    description: input.description ?? `Description for ${input.id}`,
    pluginVersion: "0.1.0",
    bundleFormat: "codex" as const,
    license: "Proprietary",
    skillsPath: "skills",
    skills: (input.skillSlugs ?? ["opentargets-skill"]).map((slug) => ({
      slug,
      description: `Description for ${slug}`,
      runtime: null,
      emoji: null,
    })),
    installedAt: "2026-04-22T00:00:00.000Z",
    source: {
      kind: "github" as const,
      repo: "openai/plugins",
      requestedRef: "main",
      resolvedCommit: "27651a43bf55185d924f7a1fc49043a0a8be65a0",
      path: "plugins/life-science-research",
    },
    bundlePath: "/tmp/.scienceswarm/market/plugins/life-science-research/bundle",
    pluginManifestPath: "/tmp/.scienceswarm/market/plugins/life-science-research/bundle/.codex-plugin/plugin.json",
    updatedAt: "2026-04-22T12:00:00.000Z",
    trust: {
      totalFiles: 9,
      scriptFileCount: 2,
      executableFileCount: 1,
      agentFileCount: 1,
      referenceFileCount: 3,
      assetFileCount: 1,
      scriptFiles: [
        "skills/opentargets-skill/scripts/query.py",
        "skills/research-router-skill/scripts/router.py",
      ],
      detectedRuntimes: ["python"],
    },
    hosts: {
      openclaw: {
        status,
        installRoot: "/tmp/.scienceswarm/openclaw/extensions/life-science-research",
        projectedSkills: (input.skillSlugs ?? ["opentargets-skill"]).map((slug) => ({
          sourceSlug: slug,
          hostSlug: slug,
          installPath: `/tmp/.scienceswarm/openclaw/extensions/life-science-research/skills/${slug}`,
          mode: "direct" as const,
        })),
      },
      codex: {
        status,
        installRoot: "/tmp/repo/.codex/skills",
        projectedSkills: (input.skillSlugs ?? ["opentargets-skill"]).map((slug) => ({
          sourceSlug: slug,
          hostSlug: slug,
          installPath: `/tmp/repo/.codex/skills/${slug}`,
          mode: "direct" as const,
        })),
      },
      "claude-code": {
        status,
        installRoot: "/tmp/repo/.claude/skills",
        projectedSkills: (input.skillSlugs ?? ["opentargets-skill"]).map((slug) => ({
          sourceSlug: slug,
          hostSlug: slug,
          installPath: `/tmp/repo/.claude/skills/${slug}`,
          mode: "direct" as const,
        })),
      },
    },
  };
}

describe("gbrain page", () => {
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

  it("restores the last project slug when the gbrain URL is missing name", async () => {
    searchParamsValue = "";
    window.localStorage.setItem("scienceswarm.project.lastSlug", "demo-project");

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }
      return Response.json({});
    }));

    render(<GbrainPage />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/dashboard/gbrain?name=demo-project");
    });
  });

  it("keeps routines discoverable while opening a requested brain artifact", async () => {
    searchParamsValue = "name=demo-project&brain_slug=wiki/concepts/tp53-mdm2";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({
          project: "demo-project",
          nextMove: { recommendation: "Review the compiled TP53 view." },
          dueTasks: [],
          frontier: [],
        });
      }

      if (url === "/api/brain/dream") {
        return Response.json({ lastRun: null });
      }

      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          schedule: { enabled: true, cron: "0 3 * * *", mode: "full" },
          nextRun: "2026-04-19T10:00:00.000Z",
        });
      }

      if (url === "/api/brain/read?path=wiki%2Fconcepts%2Ftp53-mdm2") {
        return Response.json({
          path: "wiki/concepts/tp53-mdm2",
          title: "TP53-MDM2 checkpoint",
          type: "concept",
          compiled_truth:
            "Current view: Nutlin-3 rescue is plausible in wild-type TP53 organoids, but the null p53 transcription result limits confidence.",
          frontmatter: { type: "concept", project: "demo-project" },
          timeline: [
            {
              date: "2026-04-18",
              source: "wiki/entities/papers/tp53-screen.md",
              summary: "Dream Cycle integrated the TP53 screen.",
            },
          ],
          links: [],
          backlinks: [],
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    expect(await screen.findByRole("link", { name: "Routines" })).toHaveAttribute(
      "href",
      "/dashboard/routines?name=demo-project",
    );
    expect(screen.queryByText("Dream Cycle")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Search research brain")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "TP53-MDM2 checkpoint" })).toBeInTheDocument();
    expect(screen.getAllByText(/compiled truth/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Nutlin-3 rescue is plausible/i)).toBeInTheDocument();
  });

  it("routes search results through the gbrain URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/brain/dream") {
        return Response.json({ lastRun: null });
      }

      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          schedule: { enabled: true, cron: "0 3 * * *", mode: "full" },
          nextRun: "2026-04-19T10:00:00.000Z",
        });
      }

      if (url === "/api/brain/search?query=tp53&mode=list&limit=8&detail=medium") {
        return Response.json([
          {
            path: "wiki/entities/papers/tp53-screen.md",
            title: "TP53 screen raw source",
            type: "paper",
            relevance: 0.95,
            snippet: "Raw paper chunk about TP53.",
          },
          {
            path: "wiki/concepts/tp53-mdm2.md",
            title: "TP53-MDM2 checkpoint",
            type: "concept",
            relevance: 0.7,
            snippet: "Compiled current view for TP53-MDM2.",
          },
        ]);
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    const searchInput = await screen.findByLabelText("Search research brain");
    fireEvent.change(searchInput, { target: { value: "tp53" } });

    const currentViewBadge = await screen.findByText("Current view");
    const resultButton = currentViewBadge.closest("button");
    expect(resultButton).not.toBeNull();
    expect(within(resultButton!).getByText(/TP53-MDM2 checkpoint/i)).toBeInTheDocument();

    fireEvent.click(resultButton!);

    expect(replaceMock).toHaveBeenCalledWith(
      "/dashboard/gbrain?name=demo-project&brain_slug=wiki%2Fconcepts%2Ftp53-mdm2",
    );
  });

  it("shows a generic brain search error instead of backend details", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url.startsWith("/api/brain/brief?project=")) {
        return Response.json({ project: "demo-project", dueTasks: [], frontier: [] });
      }

      if (url === "/api/brain/dream") {
        return Response.json({ lastRun: null });
      }

      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          schedule: { enabled: true, cron: "0 3 * * *", mode: "full" },
          nextRun: "2026-04-19T10:00:00.000Z",
        });
      }

      if (url === "/api/brain/search?query=tp53&mode=list&limit=8&detail=medium") {
        return Response.json(
          { error: "PGLite failed at /tmp/private-brain/db" },
          { status: 500 },
        );
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    const searchInput = await screen.findByLabelText("Search research brain");
    fireEvent.change(searchInput, { target: { value: "tp53" } });

    expect(await screen.findByText("Brain search failed. Try again.")).toBeInTheDocument();
    expect(screen.queryByText(/private-brain/i)).not.toBeInTheDocument();
  });

  it("surfaces brain status failures with a visible retry path", async () => {
    let brainStatusCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

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

      if (url === "/api/brain/dream") {
        return Response.json({ lastRun: null });
      }

      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          schedule: { enabled: true, cron: "0 3 * * *", mode: "full" },
          nextRun: "2026-04-19T10:00:00.000Z",
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Research brain is unavailable.");
    expect(screen.getByText("PGLite is locked")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry brain status" }));

    expect(await screen.findByLabelText("Search research brain")).toBeInTheDocument();
  });

  it("keeps the skills view available when gbrain is missing", async () => {
    searchParamsValue = "view=skills";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ error: "Run setup first" }, { status: 503 });
      }

      if (url === "/api/skills") {
        return Response.json({
          skills: [
            buildWorkspaceSkill({
              slug: "research-radar",
              description: "Run the radar",
              rawMarkdown: `---
name: research-radar
description: Run the radar
---

# research-radar
`,
            }),
          ],
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    expect(await screen.findByRole("heading", { name: "research-radar" })).toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith("/dashboard/gbrain?view=skills&skills_catalog=workspace&skill=research-radar");
    expect(replaceMock).not.toHaveBeenCalledWith("/setup");
  });

  it("renders the skills browser without forcing a project-scoped redirect", async () => {
    searchParamsValue = "view=skills";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url === "/api/skills") {
        return Response.json({
          skills: [
            buildWorkspaceSkill({
              slug: "db-pubmed",
              description: "Fetch papers from PubMed",
            }),
          ],
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    expect(await screen.findByText("ScienceSwarm skills")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "db-pubmed" })).toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith("/dashboard/gbrain?view=skills&skills_catalog=workspace&skill=db-pubmed");
    expect(screen.queryByText("No project selected")).not.toBeInTheDocument();
  });

  it("renders private market installs in the installed skills catalog", async () => {
    searchParamsValue = "view=skills&skills_catalog=installed&skill=life-science-research";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url === "/api/market/plugins") {
        return Response.json({
          plugins: [
            buildInstalledMarketPlugin({
              id: "life-science-research",
              displayName: "Life Science Research",
              description: "General life-sciences research workflows.",
            }),
          ],
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    expect(await screen.findByText("Private Market Installs")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Life Science Research" })).toBeInTheDocument();
    expect(screen.getByText(/resolved commit/i)).toBeInTheDocument();
  });

  it("saves a workspace skill and shows host sync guidance", async () => {
    searchParamsValue = "view=skills&skills_catalog=workspace&skill=db-pubmed";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url === "/api/skills") {
        return Response.json({
          skills: [
            buildWorkspaceSkill({
              slug: "db-pubmed",
              description: "Fetch papers from PubMed",
            }),
          ],
        });
      }

      if (url === "/api/skills/db-pubmed" && init?.method === "PUT") {
        return Response.json({
          skill: buildWorkspaceSkill({
            slug: "db-pubmed",
            description: "Updated PubMed description",
            rawMarkdown: `---
name: db-pubmed
description: Updated PubMed description
---

# db-pubmed
`,
          }),
          message: "Workspace skill saved. Sync repo host outputs to make the change live in each interface.",
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    const editor = await screen.findByLabelText("db-pubmed openclaw adapter editor");
    fireEvent.change(editor, {
      target: {
        value: `---
name: db-pubmed
description: Updated PubMed description
---

# PubMed
`,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save workspace skill" }));

    expect(await screen.findByText("Workspace skill saved.")).toBeInTheDocument();
    expect(screen.getByText(/Sync repo host outputs/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/skills/db-pubmed",
      expect.objectContaining({
        method: "PUT",
      }),
    );
  });

  it("promotes a private workspace skill into the public catalog", async () => {
    searchParamsValue = "view=skills&skills_catalog=workspace&skill=claim-checker";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url === "/api/skills") {
        return Response.json({
          skills: [
            buildWorkspaceSkill({
              slug: "claim-checker",
              description: "Cross-check scientific claims",
              status: "ready",
              tags: ["science"],
              summary: "Compares claims against supporting and conflicting evidence before publication.",
            }),
          ],
        });
      }

      if (url === "/api/skills/claim-checker/promote" && init?.method === "POST") {
        return Response.json({
          skill: buildWorkspaceSkill({
            slug: "claim-checker",
            description: "Cross-check scientific claims",
            visibility: "public",
            status: "ready",
            tags: ["science"],
            summary: "Compares claims against supporting and conflicting evidence before publication.",
            syncState: "synced",
          }),
          message:
            "Promoted into the ScienceSwarm public catalog, synced enabled host outputs, and refreshed skills/public-index.json.",
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Promote to public catalog" }));

    expect(await screen.findByText("Skill promoted.")).toBeInTheDocument();
    expect(screen.getByText(/refreshed skills\/public-index\.json/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/skills/claim-checker/promote",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("creates a new workspace skill from the visible create flow", async () => {
    searchParamsValue = "view=skills&skills_catalog=workspace&skill=db-pubmed";
    replaceMock.mockImplementation((nextUrl: string) => {
      searchParamsValue = nextUrl.split("?")[1] ?? "";
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url === "/api/skills" && !init?.method) {
        return Response.json({
          skills: [
            buildWorkspaceSkill({
              slug: "db-pubmed",
              description: "Fetch papers from PubMed",
            }),
          ],
        });
      }

      if (url === "/api/skills" && init?.method === "POST") {
        return Response.json({
          skill: buildWorkspaceSkill({
            slug: "project-alpha-revision-qa",
            name: "Project Alpha Revision QA",
            description:
              "Guide manuscript critique, revision planning, and resubmission QA for a hypothetical project-alpha paper.",
          }),
          message: "Workspace skill created.",
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));

    expect(screen.queryByRole("button", { name: "Save workspace skill" })).not.toBeInTheDocument();
    expect(screen.getByText("Create a new workspace skill")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Slug"), {
      target: { value: "project-alpha-revision-qa" },
    });
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Project Alpha Revision QA" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: {
        value:
          "Guide manuscript critique, revision planning, and resubmission QA for a hypothetical project-alpha paper.",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create skill" }));

    expect(
      await screen.findByRole("heading", { name: "Project Alpha Revision QA" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/skills",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(replaceMock).toHaveBeenCalledWith(
      "/dashboard/gbrain?view=skills&skills_catalog=workspace&skill=project-alpha-revision-qa",
    );
  });

  it("installs a private market plugin from the installed catalog flow", async () => {
    searchParamsValue = "name=demo-project&view=skills&skills_catalog=installed";
    replaceMock.mockImplementation((nextUrl: string) => {
      searchParamsValue = nextUrl.split("?")[1] ?? "";
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url === "/api/market/plugins" && !init?.method) {
        return Response.json({ plugins: [] });
      }

      if (url === "/api/market/plugins/inspect" && init?.method === "POST") {
        return Response.json({
          preview: {
            id: "life-science-research",
            name: "life-science-research",
            displayName: "Life Science Research",
            description: "General life-sciences research workflows.",
            pluginVersion: "0.1.0",
            bundleFormat: "codex",
            license: "Proprietary",
            skillsPath: "skills",
            skills: [
              {
                slug: "research-router-skill",
                description: "Route research tasks.",
                runtime: null,
                emoji: null,
              },
              {
                slug: "opentargets-skill",
                description: "Query Open Targets.",
                runtime: null,
                emoji: null,
              },
            ],
            source: {
              kind: "github",
              repo: "openai/plugins",
              requestedRef: "main",
              resolvedCommit: "27651a43bf55185d924f7a1fc49043a0a8be65a0",
              path: "plugins/life-science-research",
            },
            trust: {
              totalFiles: 12,
              scriptFileCount: 2,
              executableFileCount: 1,
              agentFileCount: 1,
              referenceFileCount: 3,
              assetFileCount: 1,
              scriptFiles: ["skills/opentargets-skill/scripts/query.py"],
              detectedRuntimes: ["python"],
            },
            hosts: {
              openclaw: {
                installRoot: "/tmp/.scienceswarm/openclaw/extensions/life-science-research",
                projectedSkills: [
                  {
                    sourceSlug: "research-router-skill",
                    hostSlug: "research-router-skill",
                    installPath: "/tmp/.scienceswarm/openclaw/extensions/life-science-research/skills/research-router-skill",
                    mode: "direct",
                  },
                ],
              },
              codex: {
                installRoot: "/tmp/repo/.codex/skills",
                projectedSkills: [
                  {
                    sourceSlug: "research-router-skill",
                    hostSlug: "research-router-skill",
                    installPath: "/tmp/repo/.codex/skills/research-router-skill",
                    mode: "direct",
                  },
                ],
              },
              "claude-code": {
                installRoot: "/tmp/repo/.claude/skills",
                projectedSkills: [
                  {
                    sourceSlug: "research-router-skill",
                    hostSlug: "research-router-skill",
                    installPath: "/tmp/repo/.claude/skills/research-router-skill",
                    mode: "direct",
                  },
                ],
              },
            },
          },
        });
      }

      if (url === "/api/market/plugins" && init?.method === "POST") {
        return Response.json({
          plugin: buildInstalledMarketPlugin({
            id: "life-science-research",
            displayName: "Life Science Research",
            description: "General life-sciences research workflows.",
            skillSlugs: ["research-router-skill", "opentargets-skill"],
          }),
          message: "Installed privately into local OpenClaw, Codex, and Claude Code surfaces.",
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Install plugin" }));
    fireEvent.change(screen.getByLabelText("Repo"), {
      target: { value: "openai/plugins" },
    });
    fireEvent.change(screen.getByLabelText("Bundle path"), {
      target: { value: "plugins/life-science-research" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Inspect bundle" }));
    expect(await screen.findByText("Install Preview")).toBeInTheDocument();
    expect(screen.getByText(/Detected runtimes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Install privately" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/market/plugins/inspect",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/market/plugins",
      expect.objectContaining({
        method: "POST",
      }),
    );
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        "/dashboard/gbrain?name=demo-project&view=skills&skills_catalog=installed&skill=life-science-research",
      );
    });
  });

  it("preserves newer edits entered while a workspace skill save is in flight", async () => {
    searchParamsValue = "view=skills&skills_catalog=workspace&skill=db-pubmed";

    let resolveSave: ((response: Response) => void) | null = null;
    const saveResponse = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url === "/api/skills") {
        return Response.json({
          skills: [
            buildWorkspaceSkill({
              slug: "db-pubmed",
              description: "Fetch papers from PubMed",
            }),
          ],
        });
      }

      if (url === "/api/skills/db-pubmed" && init?.method === "PUT") {
        return saveResponse;
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    const initialSave = `---
name: db-pubmed
description: Updated PubMed description
---

# PubMed
`;
    const newerDraft = `---
name: db-pubmed
description: Updated PubMed description
---

# PubMed

## Extra note
`;

    const editor = await screen.findByLabelText("db-pubmed openclaw adapter editor");
    fireEvent.change(editor, {
      target: {
        value: initialSave,
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save workspace skill" }));

    fireEvent.change(editor, {
      target: {
        value: newerDraft,
      },
    });

    expect(resolveSave).not.toBeNull();
    resolveSave!(
      Response.json({
        skill: buildWorkspaceSkill({
          slug: "db-pubmed",
          description: "Updated PubMed description",
          rawMarkdown: initialSave,
        }),
        message: "Workspace skill saved. Sync repo host outputs to make the change live in each interface.",
      }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("db-pubmed openclaw adapter editor")).toHaveValue(newerDraft);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save workspace skill" })).not.toBeDisabled();
    });
    expect(screen.getByText("Unsaved")).toBeInTheDocument();
    expect(screen.queryByText("Workspace skill saved.")).not.toBeInTheDocument();
  });

  it("preserves the current brain_slug when switching from skills back to pages", async () => {
    searchParamsValue = "name=demo-project&brain_slug=wiki/concepts/tp53-mdm2&view=skills&skills_catalog=workspace&skill=db-pubmed";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url === "/api/skills") {
        return Response.json({
          skills: [
            buildWorkspaceSkill({
              slug: "db-pubmed",
              description: "Fetch papers from PubMed",
            }),
          ],
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    await screen.findByRole("heading", { name: "db-pubmed" });
    fireEvent.click(screen.getByRole("button", { name: "Pages" }));

    expect(replaceMock).toHaveBeenCalledWith(
      "/dashboard/gbrain?name=demo-project&brain_slug=wiki%2Fconcepts%2Ftp53-mdm2",
    );
  });

  it("routes the paper library tab through the gbrain URL", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      if (url === "/api/brain/dream") {
        return Response.json({ lastRun: null });
      }

      if (url === "/api/brain/dream-schedule") {
        return Response.json({
          schedule: { enabled: true, cron: "0 3 * * *", mode: "full" },
          nextRun: "2026-04-19T10:00:00.000Z",
        });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    await screen.findByLabelText("Search research brain");
    fireEvent.click(screen.getByRole("button", { name: "Paper Library" }));

    expect(replaceMock).toHaveBeenCalledWith("/dashboard/gbrain?name=demo-project&view=paper-library");
  });

  it("keeps the paper library view available when gbrain is missing", async () => {
    searchParamsValue = "name=demo-project&view=paper-library";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ error: "Run setup first" }, { status: 503 });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    expect(await screen.findByText("Paper Library needs local setup.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Local research library operator" })).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith("/setup");
  });

  it("does not load the project brief in the paper library view", async () => {
    searchParamsValue = "name=demo-project&view=paper-library";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "/api/brain/status") {
        return Response.json({ pageCount: 4, backend: "gbrain" });
      }

      return Response.json({});
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<GbrainPage />);

    expect(await screen.findByRole("heading", { name: "Local research library operator" })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([request]) => {
        const url = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
        return url.startsWith("/api/brain/brief?project=");
      }),
    ).toBe(false);
  });
});
