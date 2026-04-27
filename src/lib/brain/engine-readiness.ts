import type { BrainStoreHealth } from "@/brain/store";

export interface GbrainEngineProbe {
  ok: boolean;
  health: BrainStoreHealth | null;
  cause?: string;
}

export async function probeGbrainEngineHealth(): Promise<GbrainEngineProbe> {
  try {
    const {
      describeBrainBackendError,
      ensureBrainStoreReady,
      getBrainStore,
    } = await import("@/brain/store");
    try {
      await ensureBrainStoreReady();
      const health = await getBrainStore().health();
      if (health.ok) {
        return { ok: true, health };
      }
      return {
        ok: false,
        health,
        cause: health.error ?? "Brain backend reported unhealthy state.",
      };
    } catch (error) {
      return {
        ok: false,
        health: null,
        cause: describeBrainBackendError(error),
      };
    }
  } catch (error) {
    return {
      ok: false,
      health: null,
      cause: error instanceof Error ? error.message : String(error),
    };
  }
}
