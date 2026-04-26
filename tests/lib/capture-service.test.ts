import { rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initBrain } from "@/brain/init";
import { processCapture } from "@/lib/capture";
import { readChannelSession } from "@/lib/state/channel-sessions";
import { readProjectManifest, writeProjectManifest } from "@/lib/state/project-manifests";
import {
  readPersistedRawCapture,
} from "@/lib/capture/persist-raw";
import type { ProjectManifest } from "@/brain/types";
import { createRuntimeEngine } from "@/brain/stores/gbrain-runtime.mjs";
import { resolvePgliteDatabasePath } from "@/lib/capture/materialize-memory";

const ROOT = path.join(tmpdir(), "scienceswarm-capture-service");

interface PageRow {
  id: number;
  slug: string;
  type: string;
  title: string;
  compiled_truth: string;
}
interface ReaderEngine {
  connect(config: { engine: "pglite"; database_path?: string }): Promise<void>;
  initSchema(): Promise<void>;
  disconnect(): Promise<void>;
  getPage(slug: string): Promise<PageRow | null>;
}

// Materialize-memory now writes pages into gbrain instead of markdown
// files on disk. Tests that previously read `<root>/wiki/<kind>/<slug>.md`
// via fs.readFileSync now connect to the same PGLite database the
// production materializer uses — resolved via the shared
// `resolvePgliteDatabasePath` helper so the reader and writer can never
// drift apart again (the `<brainRoot>/db` vs `<brainRoot>/brain.pglite`
// drift that flagged Track A's preflight fix).
function pageSlugFromPath(pseudoPath: string): string {
  const base = pseudoPath.split("/").pop() ?? "";
  return base.replace(/\.md$/, "");
}

async function readGbrainPage(brainRoot: string, slug: string): Promise<PageRow | null> {
  const databasePath = resolvePgliteDatabasePath(brainRoot);
  const engine = (await createRuntimeEngine({
    engine: "pglite",
    database_path: databasePath,
  })) as ReaderEngine;
  await engine.connect({ engine: "pglite", database_path: databasePath });
  await engine.initSchema();
  try {
    return await engine.getPage(slug);
  } finally {
    await engine.disconnect().catch(() => {});
  }
}

function manifest(slug: string, privacy: ProjectManifest["privacy"] = "cloud-ok"): ProjectManifest {
  return {
    version: 1,
    projectId: slug,
    slug,
    title: slug,
    privacy,
    status: "active",
    projectPagePath: `wiki/projects/${slug}.md`,
    sourceRefs: [],
    decisionPaths: [],
    taskPaths: [],
    artifactPaths: [],
    frontierPaths: [],
    activeThreads: [],
    dedupeKeys: [],
    updatedAt: "2026-04-08T00:00:00.000Z",
  };
}

beforeEach(() => {
  // Decision 3A: every brain write threads getCurrentUserHandle().
  // Set the env var explicitly so processCapture -> materializeMemory
  // doesn't throw on the citation builder.
  process.env.SCIENCESWARM_USER_HANDLE = "@test-researcher";
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  delete process.env.SCIENCESWARM_USER_HANDLE;
});

describe("capture service", () => {
  it("ambiguous capture saves unlinked and prompts once", async () => {
    initBrain({ root: ROOT, name: "Test Researcher" });
    await writeProjectManifest(manifest("alpha"), path.join(ROOT, "state"));
    await writeProjectManifest(manifest("beta"), path.join(ROOT, "state"));

    const first = await processCapture({
      brainRoot: ROOT,
      channel: "telegram",
      userId: "123",
      content: "Need to follow up on the latest assay results.",
    });

    expect(first.status).toBe("needs-clarification");
    expect(first.project).toBeNull();
    expect(first.choices).toEqual(["alpha", "beta"]);
    expect(first.materializedPath).toBeUndefined();

    const sessionAfterFirst = await readChannelSession("telegram", "123", path.join(ROOT, "state"));
    expect(sessionAfterFirst?.pendingClarification).toEqual({
      captureId: first.captureId,
      rawPath: first.rawPath,
      question: "Which study should this capture belong to?",
      choices: ["alpha", "beta"],
    });

    const rawAfterFirst = await readPersistedRawCapture(ROOT, "telegram", first.captureId);
    expect(rawAfterFirst?.requiresClarification).toBe(true);
    expect(rawAfterFirst?.project).toBeNull();

    const second = await processCapture({
      brainRoot: ROOT,
      channel: "telegram",
      userId: "123",
      content: "alpha",
    });

    expect(second.status).toBe("saved");
    expect(second.captureId).toBe(first.captureId);
    expect(second.project).toBe("alpha");
    expect(second.materializedPath).toMatch(/^wiki\/tasks\//);

    const sessionAfterSecond = await readChannelSession("telegram", "123", path.join(ROOT, "state"));
    expect(sessionAfterSecond?.pendingClarification).toBeNull();
    expect(sessionAfterSecond?.activeProject).toBe("alpha");

    const rawAfterSecond = await readPersistedRawCapture(ROOT, "telegram", first.captureId);
    expect(rawAfterSecond?.requiresClarification).toBe(false);
    expect(rawAfterSecond?.project).toBe("alpha");
    expect(rawAfterSecond?.materializedPath).toBe(second.materializedPath);

    const slug = pageSlugFromPath(second.materializedPath as string);
    const page = await readGbrainPage(ROOT, slug);
    expect(page).not.toBeNull();
    expect(page!.compiled_truth).toContain(
      "Need to follow up on the latest assay results.",
    );
  });

  it("keeps the most restrictive privacy mode in the project manifest", async () => {
    initBrain({ root: ROOT, name: "Test Researcher" });
    await writeProjectManifest(manifest("alpha", "local-only"), path.join(ROOT, "state"));

    const result = await processCapture({
      brainRoot: ROOT,
      channel: "web",
      userId: "web-user",
      project: "alpha",
      privacy: "cloud-ok",
      content: "Quick note from a less restricted source.",
    });

    expect(result.status).toBe("saved");
    const updated = await readProjectManifest("alpha", path.join(ROOT, "state"));
    expect(updated?.privacy).toBe("local-only");
  });

  it("accepts the openclaw channel and falls through to default behavior", async () => {
    initBrain({ root: ROOT, name: "Test Researcher" });
    await writeProjectManifest(manifest("alpha"), path.join(ROOT, "state"));

    const result = await processCapture({
      brainRoot: ROOT,
      channel: "openclaw",
      userId: "openclaw-user",
      project: "alpha",
      content: "Captured via openclaw agent.",
    });

    expect(result.status).toBe("saved");
    expect(result.channel).toBe("openclaw");
    expect(result.project).toBe("alpha");
    expect(result.materializedPath).toBeTruthy();

    // openclaw does not persist a Telegram-style channel session
    const session = await readChannelSession(
      "telegram",
      "openclaw-user",
      path.join(ROOT, "state"),
    );
    expect(session).toBeNull();
  });

  it("materializes captures with unique filenames for repeated titles", async () => {
    initBrain({ root: ROOT, name: "Test Researcher" });
    await writeProjectManifest(manifest("alpha"), path.join(ROOT, "state"));

    const first = await processCapture({
      brainRoot: ROOT,
      channel: "web",
      userId: "web-user",
      project: "alpha",
      kind: "decision",
      content: "We decided to sequence alpha next.",
    });

    const second = await processCapture({
      brainRoot: ROOT,
      channel: "web",
      userId: "web-user",
      project: "alpha",
      kind: "decision",
      content: "We decided to sequence alpha next.",
    });

    expect(first.materializedPath).toBeTruthy();
    expect(second.materializedPath).toBeTruthy();
    expect(second.materializedPath).not.toBe(first.materializedPath);
    const firstPage = await readGbrainPage(
      ROOT,
      pageSlugFromPath(first.materializedPath as string),
    );
    const secondPage = await readGbrainPage(
      ROOT,
      pageSlugFromPath(second.materializedPath as string),
    );
    expect(firstPage?.compiled_truth).toContain("sequence alpha");
    expect(secondPage?.compiled_truth).toContain("sequence alpha");
  });
});
