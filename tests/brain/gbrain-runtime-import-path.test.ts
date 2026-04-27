import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

describe("gbrain runtime bridge import paths", () => {
  it("supports the gbrain engine-factory export when available", async () => {
    const specifier = ["gbrain", "engine-factory"].join("/");
    try {
      const engineFactory = await import(specifier);
      expect(engineFactory.createEngine).toEqual(expect.any(Function));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/engine-factory/);
      expect(message).toMatch(/exports|resolve import|not exported/i);
    }
  });

  it("supports the gbrain extract command export when available", async () => {
    const specifier = ["gbrain", "extract"].join("/");
    try {
      const extractModule = await import(specifier);
      expect(extractModule.runExtractCore).toEqual(expect.any(Function));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/extract/);
      expect(message).toMatch(/exports|resolve import|not exported/i);
    }
  });

  it("keeps the runtime bridge importable from tests even when the package subpath is absent", async () => {
    const runtimeBridge = await import("@/brain/stores/gbrain-runtime.mjs");

    expect(runtimeBridge.createRuntimeEngine).toEqual(expect.any(Function));
  });

  it("avoids a static require.resolve gbrain literal in the runtime bridge source", async () => {
    const source = await readFile(
      new URL("../../src/brain/stores/gbrain-runtime.mjs", import.meta.url),
      "utf-8",
    );

    expect(source).not.toContain('require.resolve("gbrain")');
    expect(source).toContain("require.resolve(GBRAIN_PACKAGE_NAME)");
  });

  it("falls back to the installed gbrain extract source when the package subpath is absent", async () => {
    const brainDir = await mkdtemp(join(tmpdir(), "scienceswarm-gbrain-extract-"));
    try {
      await writeFile(
        join(brainDir, "alpha.md"),
        [
          "# Alpha",
          "",
          "[Beta](beta.md)",
          "",
          "- **2026-04-25** | lab - Observed alpha.",
          "",
        ].join("\n"),
        "utf-8",
      );
      await writeFile(join(brainDir, "beta.md"), "# Beta\n", "utf-8");

      const runtimeBridge = await import("@/brain/stores/gbrain-runtime.mjs");
      const result = await runtimeBridge.runRuntimeExtract(
        {},
        ["all", "--dir", brainDir, "--dry-run", "--json"],
      );

      expect(result).toMatchObject({
        links_created: 1,
        timeline_entries_created: 1,
        pages_processed: 2,
      });
    } finally {
      await rm(brainDir, { recursive: true, force: true });
    }
  });

  it("keeps config-status on the cheap root-readiness path", async () => {
    const configStatusSource = await readFile(
      new URL("../../src/lib/setup/config-status.ts", import.meta.url),
      "utf-8",
    );
    const rootReadinessSource = await readFile(
      new URL("../../src/lib/brain/root-readiness.ts", import.meta.url),
      "utf-8",
    );

    expect(configStatusSource).toContain('from "@/lib/brain/root-readiness"');
    expect(configStatusSource).not.toContain('from "@/lib/brain/readiness"');
    expect(rootReadinessSource).not.toContain('@/brain/store');
    expect(rootReadinessSource).not.toContain("probeGbrainEngineHealth");
  });
});
