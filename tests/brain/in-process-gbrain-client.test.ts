import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initBrain } from "@/brain/init";
import {
  createInProcessGbrainClient,
} from "@/brain/in-process-gbrain-client";
import { getBrainStore, resetBrainStore } from "@/brain/store";

let brainRoot = "";
let previousBrainRoot: string | undefined;
let previousPglitePath: string | undefined;

beforeEach(async () => {
  previousBrainRoot = process.env.BRAIN_ROOT;
  previousPglitePath = process.env.BRAIN_PGLITE_PATH;
  brainRoot = mkdtempSync(join(tmpdir(), "scienceswarm-inproc-client-"));
  process.env.BRAIN_ROOT = brainRoot;
  process.env.BRAIN_PGLITE_PATH = join(brainRoot, "brain.pglite");
  process.env.SCIENCESWARM_USER_HANDLE = "@in-process-test";
  await resetBrainStore();
  initBrain({ root: brainRoot, name: "Test Researcher" });
});

afterEach(async () => {
  await resetBrainStore();
  if (previousBrainRoot === undefined) delete process.env.BRAIN_ROOT;
  else process.env.BRAIN_ROOT = previousBrainRoot;
  if (previousPglitePath === undefined) delete process.env.BRAIN_PGLITE_PATH;
  else process.env.BRAIN_PGLITE_PATH = previousPglitePath;
  delete process.env.SCIENCESWARM_USER_HANDLE;
  rmSync(brainRoot, { recursive: true, force: true });
});

describe("createInProcessGbrainClient", () => {
  it("runs read-merge-write and links inside one queued transaction", async () => {
    const client = createInProcessGbrainClient();

    await client.persistTransaction("paper-doi-10.1000-test", async (existing) => {
      expect(existing).toBeNull();
      return {
        page: {
          type: "paper",
          title: "Transactional Paper",
          compiledTruth: "Compiled truth mentions mitochondria.",
          timeline: "- fetched via test",
          frontmatter: { entity_type: "paper", source_db: ["test"] },
        },
        links: [{
          from: "project-alpha",
          to: "paper-doi-10.1000-test",
          context: "fetched_via",
          linkType: "supports",
        }],
      };
    });

    await client.persistTransaction("paper-doi-10.1000-test", async (existing) => {
      expect(existing?.frontmatter.source_db).toEqual(["test"]);
      return {
        page: {
          type: "paper",
          title: existing?.title ?? "Transactional Paper",
          compiledTruth: `${existing?.compiledTruth ?? ""}\nUpdated once.`,
          timeline: existing?.timeline,
          frontmatter: {
            ...(existing?.frontmatter ?? {}),
            source_db: ["test", "second"],
          },
        },
      };
    });

    const page = await getBrainStore().getPage("paper-doi-10.1000-test");
    expect(page?.title).toBe("Transactional Paper");
    expect(page?.content).toContain("Updated once");
    expect(page?.frontmatter.source_db).toEqual(["test", "second"]);
  });
});
