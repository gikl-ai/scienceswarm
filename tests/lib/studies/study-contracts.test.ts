import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import type {
  LegacyStudyAlias,
  StudyId,
  StudyKnowledge,
  StudySlug,
} from "@/lib/studies";
import {
  getCanonicalScienceSwarmStateRoot,
  getLaunchBundleRoot,
  getRunStateRoot,
  getScienceSwarmKnowledgeRoot,
  getStudyAgentWorkspaceRoot,
  getStudyStateRoot,
  getThreadStateRoot,
  parseLegacyProjectSlug,
  resolveLegacyProjectToStudy,
  resolveStudyContext,
  SourceStateSchema,
  StudyKnowledgeSchema,
  StudyStateSchema,
  ThreadStateSchema,
  RunStateSchema,
  LaunchAuditStateSchema,
  type StudyLookupStore,
} from "@/lib/studies";

const ROOT = join(tmpdir(), "scienceswarm-study-contracts");

const studyAlpha: StudyKnowledge = {
  type: "study",
  id: "study_alpha",
  slug: "project-alpha",
  title: "Project Alpha",
  status: "active",
  questions: [],
  hypotheses: [],
  linkedSourceIds: [],
  linkedObjectIds: [],
  linkedArtifactIds: [],
  pinnedPageIds: [],
  deliverables: [],
  createdAt: "2026-04-26T00:00:00.000Z",
  updatedAt: "2026-04-26T00:00:00.000Z",
};

class OOneStudyStore implements StudyLookupStore {
  calls: string[] = [];
  constructor(
    private readonly byId = new Map<StudyId, StudyKnowledge>(),
    private readonly bySlug = new Map<StudySlug, StudyKnowledge>(),
    private readonly aliases = new Map<StudySlug, LegacyStudyAlias>(),
  ) {}

  async getStudyKnowledgeById(studyId: StudyId): Promise<StudyKnowledge | null> {
    this.calls.push(`id:${studyId}`);
    return this.byId.get(studyId) ?? null;
  }

  async getStudyKnowledgeBySlug(studySlug: StudySlug): Promise<StudyKnowledge | null> {
    this.calls.push(`slug:${studySlug}`);
    return this.bySlug.get(studySlug) ?? null;
  }

  async getStudyAliasByLegacyProjectSlug(legacyProjectSlug: StudySlug): Promise<LegacyStudyAlias | null> {
    this.calls.push(`alias:${legacyProjectSlug}`);
    return this.aliases.get(legacyProjectSlug) ?? null;
  }

  async listStudies(): Promise<never> {
    throw new Error("broad scans are forbidden in Study resolution");
  }
}

afterEach(() => {
  delete process.env.SCIENCESWARM_DIR;
  delete process.env.BRAIN_ROOT;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("Study contracts", () => {
  it("validates Study, Source, Thread, Run, and LaunchAudit state through Zod schemas", () => {
    expect(StudyKnowledgeSchema.parse(studyAlpha)).toEqual(studyAlpha);
    expect(SourceStateSchema.parse({
      type: "source",
      id: "source_alpha",
      slug: "source-alpha",
      title: "Source Alpha",
      kind: "repo",
      uri: "file:///repo",
      syncStrategy: "code",
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    })).toMatchObject({
      id: "source_alpha",
      indexing: { supportsStructuralGraph: false },
    });
    expect(StudyStateSchema.parse({
      version: 1,
      studyId: "study_alpha",
      legacyProjectSlug: "project-alpha",
    })).toMatchObject({
      privacyPolicy: "local-first",
      activeThreadIds: [],
    });
    expect(ThreadStateSchema.parse({
      version: 1,
      id: "thread_alpha",
      title: "Alpha question",
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
      messageLogPath: "state/threads/thread_alpha/messages.jsonl",
    })).toMatchObject({ studyIds: [], runIds: [] });
    expect(RunStateSchema.parse({
      version: 1,
      id: "run_alpha",
      studyIds: ["study_alpha"],
      host: "codex",
      launchBundlePath: "runtime/runs/run_alpha/codex",
      cwd: "workspaces/studies/study_alpha",
      status: "running",
      startedAt: "2026-04-26T00:00:00.000Z",
    })).toMatchObject({ outputs: [], writebacks: [] });
    expect(LaunchAuditStateSchema.parse({
      version: 1,
      runId: "run_alpha",
      host: "codex",
      launchBundlePath: "runtime/runs/run_alpha/codex",
      cwd: "workspaces/studies/study_alpha",
      createdAt: "2026-04-26T00:00:00.000Z",
    })).toMatchObject({ redactedEnv: {}, tokenMaterial: [] });
  });
});

describe("Study paths", () => {
  it("keeps new State, workspace, and runtime helpers outside the Knowledge root", () => {
    process.env.SCIENCESWARM_DIR = ROOT;
    const brainRoot = getScienceSwarmKnowledgeRoot();

    expect(brainRoot).toBe(join(ROOT, "brain"));
    expect(getCanonicalScienceSwarmStateRoot()).toBe(join(ROOT, "state"));
    expect(getStudyStateRoot("study_alpha")).toBe(join(ROOT, "state", "studies", "study_alpha"));
    expect(getThreadStateRoot("thread_alpha")).toBe(join(ROOT, "state", "threads", "thread_alpha"));
    expect(getRunStateRoot("run_alpha")).toBe(join(ROOT, "state", "runs", "run_alpha"));
    expect(getStudyAgentWorkspaceRoot("study_alpha")).toBe(join(ROOT, "workspaces", "studies", "study_alpha"));
    expect(getLaunchBundleRoot("run_alpha", "codex")).toBe(join(ROOT, "runtime", "runs", "run_alpha", "codex"));

    for (const resolved of [
      getCanonicalScienceSwarmStateRoot(),
      getStudyStateRoot("study_alpha"),
      getThreadStateRoot("thread_alpha"),
      getRunStateRoot("run_alpha"),
      getStudyAgentWorkspaceRoot("study_alpha"),
      getLaunchBundleRoot("run_alpha", "codex"),
    ]) {
      expect(resolved.startsWith(`${brainRoot}/`)).toBe(false);
    }
  });

  it("does not create legacy project-local .brain directories while resolving paths", () => {
    process.env.SCIENCESWARM_DIR = ROOT;
    mkdirSync(ROOT, { recursive: true });

    getStudyStateRoot("study_alpha");
    getThreadStateRoot("thread_alpha");
    getRunStateRoot("run_alpha");
    getStudyAgentWorkspaceRoot("study_alpha");
    getLaunchBundleRoot("run_alpha", "claude-code");

    expect(existsSync(join(ROOT, "projects", "project-alpha", ".brain"))).toBe(false);
    expect(existsSync(join(ROOT, "projects", "project-alpha", ".tombstone"))).toBe(false);
  });
});

describe("Study context resolution", () => {
  it("parses legacy project slugs without accepting unsafe paths", () => {
    expect(parseLegacyProjectSlug("project-alpha")).toEqual({
      ok: true,
      legacyProjectSlug: "project-alpha",
    });
    expect(parseLegacyProjectSlug("../project-alpha")).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("uses direct Study ID lookup without broad scans or slug fallback", async () => {
    const store = new OOneStudyStore(new Map([["study_alpha", studyAlpha]]));

    const context = await resolveStudyContext({ studyId: "study_alpha" }, store);

    expect(context?.studyId).toBe("study_alpha");
    expect(context?.resolution.source).toBe("study-id");
    expect(store.calls).toEqual(["id:study_alpha"]);
  });

  it("uses direct Study slug lookup without broad scans", async () => {
    const store = new OOneStudyStore(
      new Map(),
      new Map([["project-alpha", studyAlpha]]),
    );

    const result = await resolveLegacyProjectToStudy({ slug: "project-alpha" }, store);

    expect(result).toMatchObject({
      status: "resolved",
      source: "study-slug",
      studyId: "study_alpha",
    });
    expect(store.calls).toEqual(["slug:project-alpha"]);
  });

  it("resolves legacy project aliases read-only without creating .brain directories", async () => {
    process.env.SCIENCESWARM_DIR = ROOT;
    mkdirSync(join(ROOT, "projects", "project-alpha"), { recursive: true });
    const store = new OOneStudyStore(
      new Map([["study_alpha", studyAlpha]]),
      new Map(),
      new Map([[
        "legacy-alpha",
        {
          legacyProjectSlug: "legacy-alpha",
          studyId: "study_alpha",
          studySlug: "project-alpha",
        },
      ]]),
    );

    const context = await resolveStudyContext({ projectId: "legacy-alpha" }, store);

    expect(context?.legacyProjectSlug).toBe("legacy-alpha");
    expect(context?.resolution.source).toBe("legacy-alias");
    expect(store.calls).toEqual(["alias:legacy-alpha", "id:study_alpha"]);
    expect(existsSync(join(ROOT, "projects", "legacy-alpha", ".brain"))).toBe(false);
    expect(existsSync(join(ROOT, "projects", "legacy-alpha", ".tombstone"))).toBe(false);
  });
});
