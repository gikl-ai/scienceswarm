/**
 * Runtime bridge for the installed gbrain package.
 *
 * gbrain does not currently export the engine factory or command wrappers
 * through its package exports map, so this bridge centralizes the deep imports
 * until upstream exposes stable subpaths.
 */

function timelineDateKey(date) {
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  return String(date).slice(0, 10);
}

function wrapRuntimeEngine(engine) {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === "searchKeyword") {
        return async (...args) => {
          const results = await target.searchKeyword(...args);
          return results.map((result) => ({
            ...result,
            source_id: result.source_id ?? "default",
          }));
        };
      }
      if (prop === "addTimelineEntry") {
        return async (slug, entry) => {
          const existing = await target.getTimeline(slug, { limit: 100000 }).catch(() => []);
          const entryKey = `${timelineDateKey(entry.date)}::${entry.summary}`;
          if (existing.some((row) => `${timelineDateKey(row.date)}::${row.summary}` === entryKey)) {
            return undefined;
          }
          return target.addTimelineEntry(slug, entry);
        };
      }
      if (prop === "addLink") {
        return async (from, to, context, linkType) => target.addLink(
          from,
          to,
          context,
          linkType === "mention" ? "mentions" : linkType,
        );
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function createRuntimeEngine(config) {
  const { createEngine } = await import("../../../node_modules/gbrain/src/core/engine-factory.ts");
  return wrapRuntimeEngine(await createEngine(config));
}

export async function runRuntimeExtract(engine, args) {
  const extractModule = await import("../../../node_modules/gbrain/src/commands/extract.ts");
  const runExtractCore = extractModule.runExtractCore;
  const mode = args[0];
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx >= 0 && dirIdx + 1 < args.length ? args[dirIdx + 1] : ".";
  if (mode !== "links" && mode !== "timeline" && mode !== "all") {
    throw new Error(
      `Invalid gbrain extract mode "${String(mode)}"; expected links, timeline, or all.`,
    );
  }
  if (typeof runExtractCore === "function") {
    return runExtractCore(engine, {
      mode,
      dir,
      dryRun: args.includes("--dry-run"),
      jsonMode: args.includes("--json"),
    });
  }

  const runExtract = extractModule.runExtract;
  if (typeof runExtract !== "function") {
    throw new Error("Installed gbrain package does not expose an extract runner.");
  }

  let jsonOutput = "";
  const originalLog = console.log;
  if (args.includes("--json")) {
    console.log = (...parts) => {
      jsonOutput += `${parts.join(" ")}\n`;
    };
  }
  try {
    const result = await runExtract(engine, args);
    if (result !== undefined) return result;
  } finally {
    console.log = originalLog;
  }
  if (!jsonOutput.trim()) return undefined;
  return JSON.parse(jsonOutput);
}

export async function runRuntimeEmbed(engine, args) {
  const { runEmbed } = await import("../../../node_modules/gbrain/src/commands/embed.ts");
  return runEmbed(engine, args);
}

export async function performRuntimeSync(engine, opts) {
  const { performSync } = await import("../../../node_modules/gbrain/src/commands/sync.ts");
  return performSync(engine, opts);
}
