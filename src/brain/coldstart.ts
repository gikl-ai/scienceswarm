/**
 * Backward-compat shim for the coldstart module.
 *
 * The original 1,651-line `src/brain/coldstart.ts` was split into focused
 * submodules under `src/brain/coldstart/` per eng review decision 6A
 * (see `docs/superpowers/specs/2026-04-13-scienceswarm-as-gbrain-layer.md`).
 *
 * This shim re-exports the entire coldstart surface so existing import sites
 * (`@/brain/coldstart`) keep working unchanged. Delete it once Phase B touches
 * this area or imports migrate to `@/brain/coldstart/index` organically.
 *
 * Do NOT add new code here — touch the submodules directly.
 */

export * from "./coldstart/index";
