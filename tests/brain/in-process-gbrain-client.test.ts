import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initBrain } from "@/brain/init";
import {
  createInProcessGbrainClient,
} from "@/brain/in-process-gbrain-client";
import { GbrainEngineAdapter } from "@/brain/stores/gbrain-engine-adapter";
import { BrainBackendUnavailableError, getBrainStore, resetBrainStore } from "@/brain/store";

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
  it("rejects JavaScript frontmatter without executing it", async () => {
    const client = createInProcessGbrainClient();
    const globalWithProbe = globalThis as typeof globalThis & {
      __scienceswarmInProcessFrontmatterProbe?: boolean;
    };
    globalWithProbe.__scienceswarmInProcessFrontmatterProbe = false;

    await expect(
      client.putPage(
        "unsafe-js-frontmatter",
        [
          "---js",
          "globalThis.__scienceswarmInProcessFrontmatterProbe = true;",
          "module.exports = { title: 'Unsafe' };",
          "---",
          "",
          "This body should not be imported.",
        ].join("\n"),
      ),
    ).rejects.toThrow("JavaScript frontmatter is not supported");

    expect(globalWithProbe.__scienceswarmInProcessFrontmatterProbe).toBe(false);
    delete globalWithProbe.__scienceswarmInProcessFrontmatterProbe;
  });

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

  it("recovers a stale uninitialized store instance before writeback", async () => {
    await resetBrainStore();
    const state = (globalThis as typeof globalThis & {
      __scienceswarmBrainStoreState: {
        instance: unknown;
        adapterInitPromise: Promise<void> | null;
        activeBrainRoot: string | null;
      };
    }).__scienceswarmBrainStoreState;
    state.instance = new GbrainEngineAdapter();
    state.adapterInitPromise = null;
    state.activeBrainRoot = null;

    const client = createInProcessGbrainClient({ root: brainRoot });
    await client.persistTransaction("paper-library-writeback-recovery", () => ({
      page: {
        type: "paper",
        title: "Recovered Writeback",
        compiledTruth: "Writeback succeeds after the store instance is reattached.",
      },
    }));

    const page = await getBrainStore({ root: brainRoot }).getPage("paper-library-writeback-recovery");
    expect(page?.title).toBe("Recovered Writeback");
  });

  it("preserves typed brain backend failures from the shared store", async () => {
    await resetBrainStore();
    const state = (globalThis as typeof globalThis & {
      __scienceswarmBrainStoreState: {
        instance: unknown;
        adapterInitPromise: Promise<void> | null;
        activeBrainRoot: string | null;
      };
    }).__scienceswarmBrainStoreState;
    state.instance = {
      health: async () => ({
        ok: false,
        pageCount: 0,
        error: "PGLite failed to initialize",
      }),
      dispose: async () => {},
    };
    state.adapterInitPromise = null;
    state.activeBrainRoot = brainRoot;

    const client = createInProcessGbrainClient({ root: brainRoot });
    let caughtError: unknown;
    try {
      await client.persistTransaction("paper-library-backend-failure", () => ({
        page: {
          type: "paper",
          title: "Unreachable",
          compiledTruth: "This write should never reach the engine.",
        },
      }));
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(BrainBackendUnavailableError);
    expect(caughtError).toMatchObject({ detail: "PGLite failed to initialize" });
  });
});
