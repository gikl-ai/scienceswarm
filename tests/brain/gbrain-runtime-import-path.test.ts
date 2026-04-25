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
    const extractModule = await import(specifier);

    expect(extractModule.runExtractCore).toEqual(expect.any(Function));
  });

  it("keeps the runtime bridge importable from tests even when the package subpath is absent", async () => {
    const runtimeBridge = await import("@/brain/stores/gbrain-runtime.mjs");

    expect(runtimeBridge.createRuntimeEngine).toEqual(expect.any(Function));
  });
});
