import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateRuntimeEngine = vi.fn();

vi.mock("@/brain/stores/gbrain-runtime.mjs", () => ({
  createRuntimeEngine: (...args: unknown[]) => mockCreateRuntimeEngine(...args),
}));

describe("GbrainEngineAdapter initialization failures", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateRuntimeEngine.mockReset();
  });

  it("disconnects the engine when schema initialization fails", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    mockCreateRuntimeEngine.mockResolvedValue({
      connect: vi.fn().mockResolvedValue(undefined),
      initSchema: vi.fn().mockRejectedValue(new Error("schema failed")),
      disconnect,
    });
    const { GbrainEngineAdapter } = await import(
      "@/brain/stores/gbrain-engine-adapter"
    );
    const adapter = new GbrainEngineAdapter();

    await expect(adapter.initialize({ engine: "pglite" })).rejects.toThrow(
      "schema failed",
    );

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
