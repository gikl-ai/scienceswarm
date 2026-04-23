/**
 * Runtime bridge for the installed gbrain package.
 *
 * Keep ScienceSwarm on gbrain's exported package surface for the small set of
 * runtime APIs we intentionally call from the Next.js host process.
 */

export async function createRuntimeEngine(config) {
  const { createEngine } = await import("gbrain/engine-factory");
  return createEngine(config);
}

export async function runRuntimeExtract(engine, args) {
  throw new Error(
    `runRuntimeExtract is not available in this gbrain version; ` +
      `called with args=${JSON.stringify(args)}. ` +
      `Update @/brain/maintenance-jobs.ts to call a current gbrain command ` +
      `(e.g. backlinks/embed/sync) instead.`,
  );
}

export async function runRuntimeEmbed(engine, args) {
  const { runEmbed } = await import("../../../node_modules/gbrain/src/commands/embed.ts");
  return runEmbed(engine, args);
}

export async function performRuntimeSync(engine, opts) {
  const { performSync } = await import("../../../node_modules/gbrain/src/commands/sync.ts");
  return performSync(engine, opts);
}
