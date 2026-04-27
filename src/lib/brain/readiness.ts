import { existsSync } from "node:fs";
import { join } from "node:path";
export type { GbrainEngineProbe } from "@/lib/brain/engine-readiness";
export { probeGbrainEngineHealth } from "@/lib/brain/engine-readiness";

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
