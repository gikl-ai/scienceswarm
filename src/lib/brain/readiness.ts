import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrainStoreHealth } from "@/brain/store";

export function hasGbrainMetadata(root: string): boolean {
  return existsSync(join(root, "BRAIN.md")) || existsSync(join(root, "RESOLVER.md"));
}

/**
 * Cheap on-disk readiness check. Confirms the gbrain layout exists
 * (`BRAIN.md`/`RESOLVER.md` + `brain.pglite/`) but does NOT open the
 * engine. Use this only when you need to skip heavy probing — health
 * surfaces (`/api/health`, `/api/brain/status`) MUST go through
 * `probeGbrainEngineHealth` so a corrupt lock file or broken native
 * module is not painted over.
 */
export function isGbrainRootReady(root: string): boolean {
  return existsSync(root) && hasGbrainMetadata(root) && existsSync(join(root, "brain.pglite"));
}

export interface GbrainEngineProbe {
  /** True only when the engine opened and `health()` returned `ok`. */
  ok: boolean;
  /**
   * Backing health snapshot. Always present on success; may be `null`
   * when the engine never returned a snapshot (e.g. import failed
   * before health() ran).
   */
  health: BrainStoreHealth | null;
  /**
   * One-line cause string when `ok === false`. Surfaced by the readiness
   * probe so callers can render an honest error to operators (e.g.
   * "stale .gbrain-lock", "PGLite native module failed to load")
   * instead of "ready" while the brain is dead.
   */
  cause?: string;
}

/**
 * Real engine probe. Opens the configured PGLite database via
 * `ensureBrainStoreReady` + `getBrainStore().health()` and reports
 * whether the brain actually answers. Replaces the file-existence stub
 * for the health endpoint and the runtime contract surface.
 *
 * The `@/brain/store` module is loaded via dynamic import so this
 * lightweight readiness module does not statically pull in the
 * `gbrain-runtime.mjs` dependency for callers (e.g. /api/setup/status)
 * that only need the file-existence stubs above. The /api/health and
 * /api/brain/status routes call this and pay the load cost on the
 * first probe; subsequent probes reuse the singleton.
 */
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
    // Loading the store module itself failed (e.g. gbrain native
    // module could not even be required). Surface the import error
    // rather than mask it as "ready".
    return {
      ok: false,
      health: null,
      cause: error instanceof Error ? error.message : String(error),
    };
  }
}
