import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const GBRAIN_PACKAGE_NAME = ["gbrain"].join("");

/**
 * Runtime bridge for the installed gbrain package.
 *
 * Prefer package exports when the installed gbrain version provides them.
 * Fall back to the installed package path for older builds or command modules
 * that do not yet expose stable subpaths.
 */

function timelineDateKey(date) {
  if (date instanceof Date) return date.toISOString().slice(0, 10);
  return String(date).slice(0, 10);
}

function wrapRuntimeEngine(engine) {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      if (prop === "searchKeyword" && typeof target.searchKeyword === "function") {
        return async (...args) => {
          const results = await target.searchKeyword(...args);
          return Array.isArray(results)
            ? results.map((result) => ({
                ...result,
                source_id: result.source_id ?? "default",
              }))
            : results;
        };
      }
      if (
        prop === "addTimelineEntry"
        && typeof target.addTimelineEntry === "function"
      ) {
        return async (slug, entry) => {
          const getTimeline = typeof target.getTimeline === "function"
            ? target.getTimeline.bind(target)
            : async () => [];
          const existing = await getTimeline(slug, { limit: 100000 }).catch(() => []);
          const entryKey = `${timelineDateKey(entry.date)}::${entry.summary}`;
          if (
            existing.some(
              (row) => `${timelineDateKey(row.date)}::${row.summary}` === entryKey,
            )
          ) {
            return undefined;
          }
          return target.addTimelineEntry(slug, entry);
        };
      }
      if (prop === "addLink" && typeof target.addLink === "function") {
        return async (from, to, context, linkType) => target.addLink(
          from,
          to,
          context,
          linkType === "mention" ? "mentions" : linkType,
        );
      }
      if (prop === "transaction" && typeof target.transaction === "function") {
        return async (fn) =>
          target.transaction((tx) => fn(wrapRuntimeEngine(tx)));
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function resolveGbrainSourceSpecifier(relativePathFromCore) {
  // Keep the package name non-literal here. Turbopack tries to pre-resolve
  // this resolver call inside the app-route graph and can fail the build
  // before Node ever gets a chance to resolve the installed package.
  const gbrainEntryPath = require.resolve(GBRAIN_PACKAGE_NAME);
  return pathToFileURL(
    resolvePath(dirname(gbrainEntryPath), relativePathFromCore),
  ).href;
}

function isRecoverableGbrainSubpathImportError(error, packageSubpath) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  const message = "message" in error ? String(error.message) : "";
  const exportName = `gbrain/${packageSubpath}`;
  const packageExportName = `./${packageSubpath}`;
  const namesRequestedSubpath = (
    message.includes(exportName)
    || message.includes(packageExportName)
  );
  return (
    code === "ERR_PACKAGE_PATH_NOT_EXPORTED"
    || (
      (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND")
      && namesRequestedSubpath
    )
    || (
      namesRequestedSubpath
      && (
        message.includes("is not exported under the conditions")
        || message.includes(`Package subpath '${packageExportName}' is not defined by "exports"`)
        || message.includes("Failed to resolve import")
      )
    )
  );
}

async function loadCreateEngine() {
  try {
    // Keep this import literal so Next can apply `transpilePackages: ["gbrain"]`.
    // A variable import is left for Node to load at runtime, and Node 24 refuses
    // to type-strip TypeScript files under node_modules.
    const engineFactoryModule = await import("gbrain/engine-factory");
    if (typeof engineFactoryModule.createEngine === "function") {
      return engineFactoryModule.createEngine;
    }
  } catch (error) {
    // Older installed gbrain builds do not export this subpath yet.
    if (!isRecoverableGbrainSubpathImportError(error, "engine-factory")) {
      throw error;
    }
  }

  const fallbackEngineFactorySpecifier = resolveGbrainSourceSpecifier(
    "engine-factory.ts",
  );
  const fallbackEngineFactoryModule = await import(
    /* webpackIgnore: true */ /* @vite-ignore */ fallbackEngineFactorySpecifier
  );
  if (typeof fallbackEngineFactoryModule.createEngine !== "function") {
    throw new Error(
      `Installed gbrain fallback module "${fallbackEngineFactorySpecifier}" does not export createEngine.`,
    );
  }
  return fallbackEngineFactoryModule.createEngine;
}

async function loadExtractModule() {
  try {
    // gbrain 0.20 exports this command subpath; use it before falling back
    // to the installed source path used by older pins.
    const extractSpecifier = ["gbrain", "extract"].join("/");
    return await import(/* webpackIgnore: true */ /* @vite-ignore */ extractSpecifier);
  } catch (error) {
    if (!isRecoverableGbrainSubpathImportError(error, "extract")) {
      throw error;
    }
  }

  return import(
    /* webpackIgnore: true */ /* @vite-ignore */ resolveGbrainSourceSpecifier("../commands/extract.ts")
  );
}

export async function createRuntimeEngine(config) {
  const createEngine = await loadCreateEngine();
  return wrapRuntimeEngine(await createEngine(config));
}

export async function runRuntimeExtract(engine, args) {
  const extractModule = await loadExtractModule();
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
  const { runEmbed } = await import(
    /* webpackIgnore: true */ /* @vite-ignore */ resolveGbrainSourceSpecifier("../commands/embed.ts")
  );
  return runEmbed(engine, args);
}

export async function performRuntimeSync(engine, opts) {
  const { performSync } = await import(
    /* webpackIgnore: true */ /* @vite-ignore */ resolveGbrainSourceSpecifier("../commands/sync.ts")
  );
  return performSync(engine, opts);
}
