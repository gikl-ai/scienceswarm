/**
 * Runtime bridge for the installed gbrain package.
 *
 * The public gbrain package ships `src/core/engine-factory.ts` but does not
 * currently export that subpath in package.json. Importing the file directly
 * keeps ScienceSwarm on the public package surface instead of depending on a
 * dirty local checkout.
 */

export async function createRuntimeEngine(config) {
  const { createEngine } = await import("../../../node_modules/gbrain/src/core/engine-factory.ts");
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
