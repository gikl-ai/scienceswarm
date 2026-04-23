import { describe, expect, it } from "vitest";

describe("gbrain runtime bridge import paths", () => {
  it("loads engine-factory through the gbrain package export", async () => {
    const specifier = ["gbrain", "engine-factory"].join("/");
    const engineFactory = await import(specifier);

    expect(engineFactory.createEngine).toEqual(expect.any(Function));
  });

  it("keeps the runtime bridge importable from tests", async () => {
    const runtimeBridge = await import("@/brain/stores/gbrain-runtime.mjs");

    expect(runtimeBridge.createRuntimeEngine).toEqual(expect.any(Function));
  });
});
