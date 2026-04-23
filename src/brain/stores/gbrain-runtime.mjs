import { readFile } from "node:fs/promises";

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

  return runRuntimeExtractFallback(engine, extractModule, mode, dir, args.includes("--dry-run"));
}

async function runRuntimeExtractFallback(engine, extractModule, mode, dir, dryRun) {
  const {
    walkMarkdownFiles,
    extractLinksFromFile,
    extractTimelineFromContent,
  } = extractModule;
  if (
    typeof walkMarkdownFiles !== "function"
    || typeof extractLinksFromFile !== "function"
    || typeof extractTimelineFromContent !== "function"
  ) {
    throw new Error("Installed gbrain package does not expose extract helpers.");
  }

  const files = walkMarkdownFiles(dir);
  const allSlugs = new Set(files.map((file) => file.relPath.replace(/\.md$/, "")));
  const result = {
    links_created: 0,
    timeline_entries_created: 0,
    pages_processed: files.length,
  };

  for (const file of files) {
    let content;
    try {
      content = await readFile(file.path, "utf-8");
    } catch {
      continue;
    }

    const slug = file.relPath.replace(/\.md$/, "");
    if (mode === "links" || mode === "all") {
      const links = extractLinksFromFile(content, file.relPath, allSlugs);
      for (const link of links) {
        if (dryRun) {
          result.links_created += 1;
          continue;
        }
        try {
          await engine.addLink(link.from_slug, link.to_slug, link.context, link.link_type);
          result.links_created += 1;
        } catch {
          // Match gbrain's CLI behavior: skip duplicate or missing-page links.
        }
      }
    }

    if (mode === "timeline" || mode === "all") {
      const entries = extractTimelineFromContent(content, slug);
      for (const entry of entries) {
        if (dryRun) {
          result.timeline_entries_created += 1;
          continue;
        }
        try {
          await engine.addTimelineEntry(entry.slug, {
            date: entry.date,
            source: entry.source,
            summary: entry.summary,
            detail: entry.detail,
          });
          result.timeline_entries_created += 1;
        } catch {
          // Match gbrain's CLI behavior: skip duplicate or missing-page entries.
        }
      }
    }
  }

  return result;
}

export async function runRuntimeEmbed(engine, args) {
  const { runEmbed } = await import("../../../node_modules/gbrain/src/commands/embed.ts");
  return runEmbed(engine, args);
}

export async function performRuntimeSync(engine, opts) {
  const { performSync } = await import("../../../node_modules/gbrain/src/commands/sync.ts");
  return performSync(engine, opts);
}
