/**
 * Backward-compat shim for the coldstart module.
 *
 * The original 1,651-line `src/brain/coldstart.ts` was split into focused
 * submodules under `src/brain/coldstart/` during the gbrain pivot.
 *
 * This shim re-exports the entire coldstart surface so existing import sites
 * (`@/brain/coldstart`) keep working unchanged. Delete it once Phase B touches
 * this area or imports migrate to `@/brain/coldstart/index` organically.
 *
 * Do NOT add new code here — touch the submodules directly.
 */

export * from "./coldstart/index";
