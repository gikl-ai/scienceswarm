/**
 * Runtime bridge for the installed gbrain package.
 *
 * `createRuntimeEngine` uses gbrain's exported `gbrain/engine-factory`
 * subpath. The command wrappers below still reach into internal gbrain
 * command modules until upstream exports stable package subpaths for them.
 */

export async function createRuntimeEngine(config) {
  const { createEngine } = await import("gbrain/engine-factory");
  return createEngine(config);
}

export async function runRuntimeExtract(engine, args) {
  const { runExtractCore } = await import("../../../node_modules/gbrain/src/commands/extract.ts");
  const mode = args[0];
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 && dirIdx + 1 < args.length ? args[dirIdx + 1] : ".";
  if (mode !== "links" && mode !== "timeline" && mode !== "all") {
    throw new Error(
      `Invalid gbrain extract mode "${String(mode)}"; expected links, timeline, or all.`,
    );
  }
  return runExtractCore(engine, {
    mode,
    dir,
    dryRun: args.includes("--dry-run"),
    jsonMode: args.includes("--json"),
  });
}

export async function runRuntimeEmbed(engine, args) {
  const { runEmbed } = await import("../../../node_modules/gbrain/src/commands/embed.ts");
  return runEmbed(engine, args);
}

export async function performRuntimeSync(engine, opts) {
  const { performSync } = await import("../../../node_modules/gbrain/src/commands/sync.ts");
  return performSync(engine, opts);
}
