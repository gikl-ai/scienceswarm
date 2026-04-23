import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRuntimeEngine,
  runRuntimeExtract,
} from "@/brain/stores/gbrain-runtime.mjs";

interface RuntimeEngine {
  connect(config: { engine: "pglite" }): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  putPage(
    slug: string,
    page: {
      type: string;
      title: string;
      compiled_truth: string;
      timeline?: string;
      frontmatter?: Record<string, unknown>;
    },
  ): Promise<unknown>;
  getLinks(slug: string): Promise<Array<{ to_slug: string; link_type: string }>>;
  getTimeline(slug: string): Promise<Array<{ date: string | Date; summary: string }>>;
}

describe("gbrain runtime bridge", () => {
  let root: string;
  let engine: RuntimeEngine;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "scienceswarm-gbrain-runtime-"));
    engine = (await createRuntimeEngine({ engine: "pglite" })) as RuntimeEngine;
    await engine.connect({ engine: "pglite" });
    await engine.initSchema();
  });

  afterEach(async () => {
    await engine.disconnect();
    rmSync(root, { recursive: true, force: true });
  });

  it("uses gbrain's native extract runner for links and timeline entries", async () => {
    const sourceMarkdown = [
      "# Source",
      "",
      "See [Target](target.md).",
      "",
      "- **2026-04-16** | Notebook - Result captured.",
    ].join("\n");
    writeFileSync(join(root, "source.md"), sourceMarkdown, "utf-8");
    writeFileSync(join(root, "target.md"), "# Target\n", "utf-8");

    await engine.putPage("source", {
      type: "note",
      title: "Source",
      compiled_truth: sourceMarkdown,
      timeline: "",
      frontmatter: {},
    });
    await engine.putPage("target", {
      type: "note",
      title: "Target",
      compiled_truth: "Target body.",
      timeline: "",
      frontmatter: {},
    });

    await expect(
      runRuntimeExtract(engine, ["links", "--dir", root, "--json"]),
    ).resolves.toMatchObject({ links_created: 1, pages_processed: 2 });
    await expect(
      runRuntimeExtract(engine, ["timeline", "--dir", root, "--json"]),
    ).resolves.toMatchObject({ timeline_entries_created: 1, pages_processed: 2 });

    expect(await engine.getLinks("source")).toEqual([
      expect.objectContaining({
        to_slug: "target",
        link_type: "mention",
      }),
    ]);
    expect(await engine.getTimeline("source")).toEqual([
      expect.objectContaining({
        date: expect.anything(),
        summary: "Result captured.",
      }),
    ]);
  });
});
