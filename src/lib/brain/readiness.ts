import { hasGbrainMetadata, isGbrainRootReady } from "@/lib/brain/root-readiness";

export type { GbrainEngineProbe } from "@/lib/brain/engine-readiness";
export { probeGbrainEngineHealth } from "@/lib/brain/engine-readiness";

/**
 * Backwards-compatible barrel for callers that still import
 * `@/lib/brain/readiness`. Cheap root checks live in
 * `root-readiness.ts`, and the heavy engine probe lives in
 * `engine-readiness.ts`.
 */
export { hasGbrainMetadata, isGbrainRootReady };
