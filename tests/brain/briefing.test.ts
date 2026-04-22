import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";
import { buildGuideBriefing, buildProjectBrief } from "@/brain/briefing";
import { logEvent } from "@/brain/cost";
import { ensureBrainStoreReady, getBrainStore, resetBrainStore } from "@/brain/store";
import type { BrainConfig } from "@/brain/types";
import { readProjectManifest, writeProjectManifest } from "@/lib/state/project-manifests";
import { writeProjectWatchConfig } from "@/lib/watch/store";

const TEST_ROOT = join(tmpdir(), "scienceswarm-brain-test-briefing");
const BRAIN_ROOT = join(TEST_ROOT, "brain");
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;
const ORIGINAL_SCIENCESWARM_USER_HANDLE = process.env.SCIENCESWARM_USER_HANDLE;

function projectBrainRoot(slug = "alpha"): string {
  return join(TEST_ROOT, "projects", slug, ".brain");
}

function projectWikiPath(slug: string, relativePath: string): string {
  return join(projectBrainRoot(slug), relativePath);
}

function projectStateRoot(slug = "alpha"): string {
  return join(projectBrainRoot(slug), "state");
}

function makeConfig(): BrainConfig {
  return {
    root: BRAIN_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  process.env.SCIENCESWARM_DIR = TEST_ROOT;
  process.env.SCIENCESWARM_USER_HANDLE = "briefing-tester";
  initBrain({ root: BRAIN_ROOT, name: "Test Researcher" });
});

afterEach(async () => {
  await resetBrainStore();
  rmSync(TEST_ROOT, { recursive: true, force: true });
  vi.unstubAllGlobals();
  if (ORIGINAL_SCIENCESWARM_DIR) {
    process.env.SCIENCESWARM_DIR = ORIGINAL_SCIENCESWARM_DIR;
  } else {
    delete process.env.SCIENCESWARM_DIR;
  }
  if (ORIGINAL_SCIENCESWARM_USER_HANDLE) {
    process.env.SCIENCESWARM_USER_HANDLE = ORIGINAL_SCIENCESWARM_USER_HANDLE;
  } else {
    delete process.env.SCIENCESWARM_USER_HANDLE;
  }
});

describe("briefing core", () => {
  it("builds a project brief from manifest-backed pages", async () => {
    mkdirSync(projectWikiPath("alpha", "wiki/projects"), { recursive: true });
    mkdirSync(projectWikiPath("alpha", "wiki/tasks"), { recursive: true });
    mkdirSync(projectWikiPath("alpha", "wiki/entities/frontier"), { recursive: true });
    writeFileSync(
      projectWikiPath("alpha", "wiki/projects/alpha.md"),
      "---\n" +
        "type: project\n" +
        "title: Alpha Project\n" +
        "status: active\n" +
        "---\n" +
        "# Alpha Project\n" +
        "Alpha summary for the project."
    );
    writeFileSync(
      projectWikiPath("alpha", "wiki/tasks/alpha-task.md"),
      "---\n" +
        "type: task\n" +
        "title: Ship alpha slice\n" +
        "status: open\n" +
        "---\n" +
        "# Ship alpha slice\n" +
        "Finish the alpha slice."
    );
    writeFileSync(
      projectWikiPath("alpha", "wiki/entities/frontier/alpha-frontier.md"),
      "---\n" +
        "type: frontier_item\n" +
        "title: Alpha frontier\n" +
        "status: staged\n" +
        "---\n" +
        "# Alpha frontier\n" +
        "A new external signal."
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [{ kind: "import", ref: "raw/imports/alpha" }],
        decisionPaths: [],
        taskPaths: ["wiki/tasks/alpha-task.md"],
        artifactPaths: [],
        frontierPaths: ["wiki/entities/frontier/alpha-frontier.md"],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    );

    const brief = await buildProjectBrief({
      config: makeConfig(),
      project: "alpha",
    });

    expect(brief.project).toBe("alpha");
    expect(brief.topMatters.length).toBeGreaterThan(0);
    expect(brief.dueTasks[0].title).toBe("Ship alpha slice");
    expect(brief.frontier[0].title).toBe("Alpha frontier");
    expect(brief.nextMove.recommendation).toContain("Ship alpha slice");
  });

  it("prefers the summary section over raw markdown headings in project briefs", async () => {
    mkdirSync(projectWikiPath("alpha", "wiki/projects"), { recursive: true });
    writeFileSync(
      projectWikiPath("alpha", "wiki/projects/alpha.md"),
      "---\n" +
        "type: project\n" +
        "title: Alpha Project\n" +
        "status: active\n" +
        "---\n" +
        "# Alpha Project\n\n" +
        "## Summary\n" +
        "Alpha sequencing project for primer design and assay validation.\n\n" +
        "## Imported Files\n" +
        "- notes/summary.md\n",
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    );

    const brief = await buildProjectBrief({
      config: makeConfig(),
      project: "alpha",
    });

    expect(brief.topMatters[0].summary).toContain("Alpha sequencing project for primer design and assay validation.");
    expect(brief.topMatters[0].summary).not.toContain("#");
    expect(brief.topMatters[0].summary).not.toContain("Imported Files");
  });

  it("extracts a trailing summary section when it is the last heading in the page", async () => {
    mkdirSync(projectWikiPath("alpha", "wiki/projects"), { recursive: true });
    writeFileSync(
      projectWikiPath("alpha", "wiki/projects/alpha.md"),
      "---\n" +
        "type: project\n" +
        "title: Alpha Project\n" +
        "status: active\n" +
        "---\n" +
        "# Alpha Project\n\n" +
        "## Summary\n" +
        "Alpha sequencing project for primer design and assay validation.\n",
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    );

    const brief = await buildProjectBrief({
      config: makeConfig(),
      project: "alpha",
    });

    expect(brief.topMatters[0].summary).toBe(
      "Alpha sequencing project for primer design and assay validation.",
    );
    expect(brief.topMatters[0].summary).not.toContain("#");
  });

  it("does not turn placeholder project summaries into a fake next action", async () => {
    mkdirSync(projectWikiPath("alpha", "wiki/projects"), { recursive: true });
    writeFileSync(
      projectWikiPath("alpha", "wiki/projects/alpha.md"),
      "---\n" +
        "type: project\n" +
        "title: Alpha Project\n" +
        "status: active\n" +
        "---\n" +
        "# Alpha Project\n\n" +
        "New project.\n",
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    );

    const brief = await buildProjectBrief({
      config: makeConfig(),
      project: "alpha",
    });

    expect(brief.nextMove.recommendation).toBe(
      "Import a local archive or add a clear project description for Alpha Project so the brief can become specific.",
    );
  });

  it("treats title-prefixed fallback summaries as generic project matter", async () => {
    mkdirSync(projectWikiPath("alpha", "wiki/projects"), { recursive: true });
    writeFileSync(
      projectWikiPath("alpha", "wiki/projects/alpha.md"),
      "---\n" +
        "type: project\n" +
        "title: Alpha Project\n" +
        "status: active\n" +
        "---\n" +
        "# Alpha Project\n\n" +
        "Alpha Project is initialized and awaiting linked pages.\n",
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    );

    const brief = await buildProjectBrief({
      config: makeConfig(),
      project: "alpha",
    });

    expect(brief.nextMove.recommendation).toBe(
      "Import a local archive or add a clear project description for Alpha Project so the brief can become specific.",
    );
  });

  it("prioritizes the latest event-backed project evidence even when manifest paths use project wiki paths", async () => {
    mkdirSync(projectWikiPath("alpha", "wiki/projects"), { recursive: true });
    mkdirSync(projectWikiPath("alpha", "wiki/resources"), { recursive: true });
    writeFileSync(
      projectWikiPath("alpha", "wiki/projects/alpha.md"),
      "---\n" +
        "type: project\n" +
        "title: Alpha Project\n" +
        "status: active\n" +
        "project: alpha\n" +
        "---\n" +
        "# Alpha Project\n\n" +
        "## Summary\n" +
        "Baseline project description.\n",
    );
    writeFileSync(
      projectWikiPath("alpha", "wiki/resources/working-view.md"),
      "---\n" +
        "type: note\n" +
        "title: Working view\n" +
        "project: alpha\n" +
        "date: 2026-04-22\n" +
        "---\n" +
        "# Working view\n" +
        "Combined inhibition leaves a survivor population with unclear mechanism.\n",
    );
    writeFileSync(
      projectWikiPath("alpha", "wiki/resources/washout-followup.md"),
      "---\n" +
        "type: note\n" +
        "title: Washout follow-up\n" +
        "project: alpha\n" +
        "date: 2026-04-22\n" +
        "---\n" +
        "# Washout follow-up\n" +
        "Washout and rechallenge weaken rebound and strengthen a persister-state explanation.\n",
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    );

    await ensureBrainStoreReady();
    await getBrainStore().importCorpus(projectBrainRoot("alpha"));
    logEvent(makeConfig(), {
      ts: "2026-04-22T16:00:00.000Z",
      type: "ingest",
      created: ["wiki/resources/washout-followup.md"],
    });

    const brief = await buildProjectBrief({
      config: makeConfig(),
      project: "alpha",
    });

    expect(brief.topMatters[0].summary).toContain("Washout and rechallenge weaken rebound");
    expect(brief.topMatters[0].evidence[0]).toContain("washout-followup.md");
    expect(brief.nextMove.recommendation).toContain("Washout follow-up");
  });

  it("builds a compatibility guide briefing with reading suggestions", async () => {
    mkdirSync(join(TEST_ROOT, "wiki/resources"), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, "wiki/resources/focus-note.md"),
      "---\n" +
        "type: note\n" +
        "tags: [neuroscience]\n" +
        "---\n" +
        "# Focus Note\n" +
        "Brain plasticity research."
    );

    const brief = await buildGuideBriefing(makeConfig(), "neuroscience");
    expect(brief.focus).toBe("neuroscience");
    expect(Array.isArray(brief.suggestions)).toBe(true);
    expect(Array.isArray(brief.readingSuggestions)).toBe(true);
    expect(Array.isArray(brief.recentChanges)).toBe(true);
  });

  it("pulls configured watch items into the project brief frontier", async () => {
    mkdirSync(projectWikiPath("alpha", "wiki/projects"), { recursive: true });
    writeFileSync(
      projectWikiPath("alpha", "wiki/projects/alpha.md"),
      "---\n" +
        "type: project\n" +
        "title: Alpha Project\n" +
        "---\n" +
        "# Alpha Project\n" +
        "Alpha sequencing project."
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [{ kind: "import", ref: "crispr sequencing alpha project" }],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    );
    await writeProjectWatchConfig(
      "alpha",
      {
        version: 1,
        keywords: ["crispr", "sequencing"],
        promotionThreshold: 5,
        stagingThreshold: 2,
        sources: [
          {
            id: "alpha-rss",
            type: "rss",
            url: "https://example.com/feed.xml",
            label: "alpha feed",
          },
        ],
      },
      projectStateRoot("alpha"),
    );

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(
        [
          "<rss><channel>",
          "<item>",
          "<title>CRISPR sequencing progress for alpha project</title>",
          "<link>https://example.com/alpha-news</link>",
          "<description>Sequencing progress update for the alpha project.</description>",
          `<pubDate>${new Date().toUTCString()}</pubDate>`,
          "</item>",
          "</channel></rss>",
        ].join(""),
        { status: 200 },
      ),
    ));

    const brief = await buildProjectBrief({
      config: makeConfig(),
      project: "alpha",
    });

    expect(brief.frontier).toHaveLength(1);
    expect(brief.frontier[0].title).toContain("CRISPR sequencing progress");
    expect(brief.frontier[0].status).toBe("promoted");
  });

  it("keeps briefing available when one watch source fails", async () => {
    mkdirSync(projectWikiPath("alpha", "wiki/projects"), { recursive: true });
    writeFileSync(
      projectWikiPath("alpha", "wiki/projects/alpha.md"),
      "---\n" +
        "type: project\n" +
        "title: Alpha Project\n" +
        "---\n" +
        "# Alpha Project\n" +
        "Alpha sequencing project."
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [{ kind: "import", ref: "crispr sequencing alpha project" }],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    );
    await writeProjectWatchConfig(
      "alpha",
      {
        version: 1,
        keywords: ["crispr", "sequencing"],
        promotionThreshold: 5,
        stagingThreshold: 2,
        sources: [
          {
            id: "bad-rss",
            type: "rss",
            url: "https://example.com/bad.xml",
            label: "bad feed",
          },
          {
            id: "good-rss",
            type: "rss",
            url: "https://example.com/good.xml",
            label: "good feed",
          },
        ],
      },
      projectStateRoot("alpha"),
    );

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("bad.xml")) {
        throw new Error("feed offline");
      }

      return new Response(
        [
          "<rss><channel>",
          "<item>",
          "<title>CRISPR sequencing progress for alpha project</title>",
          "<link>https://example.com/alpha-news</link>",
          "<description>Sequencing progress update for the alpha project.</description>",
          `<pubDate>${new Date().toUTCString()}</pubDate>`,
          "</item>",
          "</channel></rss>",
        ].join(""),
        { status: 200 },
      );
    }));

    const brief = await buildProjectBrief({
      config: makeConfig(),
      project: "alpha",
    });

    expect(brief.frontier).toHaveLength(1);
    expect(brief.frontier[0].title).toContain("CRISPR sequencing progress");
  });

  it("writes unique frontier paths for colliding long titles", async () => {
    mkdirSync(projectWikiPath("alpha", "wiki/projects"), { recursive: true });
    writeFileSync(
      projectWikiPath("alpha", "wiki/projects/alpha.md"),
      "---\n" +
        "type: project\n" +
        "title: Alpha Project\n" +
        "---\n" +
        "# Alpha Project\n" +
        "Alpha sequencing project."
    );

    await writeProjectManifest(
      {
        version: 1,
        projectId: "alpha",
        slug: "alpha",
        title: "Alpha Project",
        privacy: "cloud-ok",
        status: "active",
        projectPagePath: "wiki/projects/alpha.md",
        sourceRefs: [{ kind: "import", ref: "crispr sequencing alpha project" }],
        decisionPaths: [],
        taskPaths: [],
        artifactPaths: [],
        frontierPaths: [],
        activeThreads: [],
        dedupeKeys: [],
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    );
    await writeProjectWatchConfig(
      "alpha",
      {
        version: 1,
        keywords: ["crispr", "sequencing"],
        promotionThreshold: 5,
        stagingThreshold: 2,
        sources: [
          {
            id: "alpha-rss",
            type: "rss",
            url: "https://example.com/collision.xml",
            label: "collision feed",
            limit: 2,
          },
        ],
      },
      projectStateRoot("alpha"),
    );

    const longPrefix = "CRISPR sequencing progress for alpha project with a very long collision prefix that differs only at the end ";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(
        [
          "<rss><channel>",
          "<item>",
          `<title>${longPrefix}A</title>`,
          "<link>https://example.com/alpha-news-a</link>",
          "<description>Sequencing progress update A.</description>",
          `<pubDate>${new Date().toUTCString()}</pubDate>`,
          "</item>",
          "<item>",
          `<title>${longPrefix}B</title>`,
          "<link>https://example.com/alpha-news-b</link>",
          "<description>Sequencing progress update B.</description>",
          `<pubDate>${new Date().toUTCString()}</pubDate>`,
          "</item>",
          "</channel></rss>",
        ].join(""),
        { status: 200 },
      ),
    ));

    await buildProjectBrief({
      config: makeConfig(),
      project: "alpha",
    });

    const manifest = await readProjectManifest("alpha", projectStateRoot("alpha"));
    expect(manifest?.frontierPaths).toHaveLength(2);
    expect(new Set(manifest?.frontierPaths ?? []).size).toBe(2);
  });
});
