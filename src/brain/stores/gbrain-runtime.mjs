/**
 * Runtime bridge for the installed gbrain package.
 *
 * `createRuntimeEngine` and the command wrappers below reach into internal
 * gbrain modules until upstream exports stable package subpaths for them.
 */

export async function createRuntimeEngine(config) {
  const { createEngine } = await import(
    "../../../node_modules/gbrain/src/core/engine-factory.ts"
  );
  const engine = await createEngine(config);
  return withScienceSwarmCompat(engine);
}

function withScienceSwarmCompat(engine) {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === "searchKeyword" && typeof target.searchKeyword === "function") {
        return async (...args) => {
          const results = await target.searchKeyword(...args);
          return Array.isArray(results)
            ? results.map((result) =>
                result && typeof result === "object" && !("source_id" in result)
                  ? { ...result, source_id: "default" }
                  : result,
              )
            : results;
        };
      }

      if (prop === "addTimelineEntry" && typeof target.addTimelineEntry === "function") {
        return async (slug, entry) => {
          const rows = typeof target.getTimeline === "function"
            ? await target.getTimeline(slug, { limit: 1000 }).catch(() => [])
            : [];
          const entryDate = String(entry.date).slice(0, 10);
          const alreadyPresent = rows.some((row) => {
            const rowDate = row.date instanceof Date
              ? row.date.toISOString().slice(0, 10)
              : String(row.date).slice(0, 10);
            return rowDate === entryDate && row.summary === entry.summary;
          });
          if (alreadyPresent) return;
          return target.addTimelineEntry(slug, entry);
        };
      }

      if (prop === "transaction" && typeof target.transaction === "function") {
        return async (fn) =>
          target.transaction((tx) => fn(withScienceSwarmCompat(tx)));
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function runRuntimeExtract(engine, args) {
  const { runExtract } = await import("../../../node_modules/gbrain/src/commands/extract.ts");
  const mode = args[0];
  if (mode !== "links" && mode !== "timeline" && mode !== "all") {
    throw new Error(
      `Invalid gbrain extract mode "${String(mode)}"; expected links, timeline, or all.`,
    );
  }
  const captured = [];
  const originalLog = console.log;
  try {
    console.log = (...values) => {
      captured.push(values.map(String).join(" "));
    };
    await runExtract(engine, args);
  } finally {
    console.log = originalLog;
  }
  if (!args.includes("--json")) {
    return undefined;
  }
  const output = captured.join("\n").trim();
  return output ? JSON.parse(output) : undefined;
}

export async function runRuntimeEmbed(engine, args) {
  const { runEmbed } = await import("../../../node_modules/gbrain/src/commands/embed.ts");
  return runEmbed(engine, args);
}

export async function performRuntimeSync(engine, opts) {
  const { performSync } = await import("../../../node_modules/gbrain/src/commands/sync.ts");
  return performSync(engine, opts);
}
