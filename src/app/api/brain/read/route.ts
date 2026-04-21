/**
 * GET /api/brain/read
 *
 * Read a file from the brain wiki.
 * Query param: ?path=wiki/entities/papers/foo.md
 * Path traversal protection: resolved path must stay within brain root.
 */

import { getBrainStore, ensureBrainStoreReady } from "@/brain/store";
import { realpathSync } from "fs";
import { isAbsolute, relative, resolve, normalize } from "path";
import { readBrainFile } from "@/brain/source";
import { getBrainConfig, isErrorResponse } from "../_shared";
import { displayTitleForBrainPage } from "@/brain/page-title";
import { toPublicBrainLink, toPublicBrainSlug } from "@/brain/public-slug";

export async function GET(request: Request) {
  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;
  const config = configOrError;

  const url = new URL(request.url);
  const filePath = url.searchParams.get("path");

  if (!filePath || typeof filePath !== "string") {
    return Response.json(
      { error: "Missing required query parameter: path" },
      { status: 400 }
    );
  }

  // Path traversal protection: resolve and verify within brain root
  const normalizedRoot = resolve(config.root);
  const resolvedPath = resolve(normalizedRoot, normalize(filePath));

  if (!isPathInside(normalizedRoot, resolvedPath)) {
    return Response.json(
      { error: "Path traversal denied" },
      { status: 403 }
    );
  }

  try {
    // Try gbrain before disk. Some pages are gbrain-only and have no
    // markdown mirror, so doing realpathSync first incorrectly 404s them.
    let storePage:
      | Awaited<ReturnType<ReturnType<typeof getBrainStore>["getPage"]>>
      | null = null;
    let store: ReturnType<typeof getBrainStore> | null = null;
    try {
      await ensureBrainStoreReady();
      store = getBrainStore();
      storePage = await store.getPage(normalize(filePath));
    } catch {
      // Store unavailable or not initialized — fall through to filesystem.
    }
    if (store && storePage) {
      const [timeline, backlinks, links] = await Promise.all([
        store.getTimeline(storePage.path, { limit: 50 }),
        store.getBacklinks(storePage.path),
        store.getLinks(storePage.path),
      ]);
      return Response.json({
        path: toPublicBrainSlug(storePage.path),
        title: displayTitleForBrainPage({
          title: storePage.title,
          path: storePage.path,
          frontmatter: storePage.frontmatter ?? {},
        }),
        type: storePage.type,
        content: storePage.content,
        compiled_truth: storePage.content,
        frontmatter: storePage.frontmatter ?? {},
        timeline,
        backlinks: backlinks.map(toPublicBrainLink),
        links: links.map(toPublicBrainLink),
      });
    }

    let realRoot: string;
    try {
      realRoot = realpathSync(normalizedRoot);
    } catch {
      return Response.json(
        { error: "Brain root not found" },
        { status: 500 }
      );
    }

    // Symlink escape protection for the legacy disk fallback: follow
    // symlinks and re-check containment only after the gbrain lookup.
    let realPath: string | null = null;
    for (const candidate of diskLookupCandidates(filePath)) {
      const candidatePath = resolve(normalizedRoot, candidate);
      if (!isPathInside(normalizedRoot, candidatePath)) continue;
      try {
        realPath = realpathSync(candidatePath);
        break;
      } catch {
        // Try the next public-slug/file-extension candidate.
      }
    }

    if (!realPath) {
      return Response.json(
        { error: "File not found" },
        { status: 404 }
      );
    }

    if (!isPathInside(realRoot, realPath)) {
      return Response.json(
        { error: "Access denied" },
        { status: 403 }
      );
    }

    const content = await readBrainFile(realPath);
    return Response.json({ path: toPublicBrainSlug(filePath), content });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Read failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function diskLookupCandidates(filePath: string): string[] {
  const normalized = normalize(filePath);
  const candidates = [normalized];
  if (!/\.(?:md|mdx)$/i.test(normalized)) {
    candidates.push(`${normalized}.md`);
  }
  return [...new Set(candidates)];
}
