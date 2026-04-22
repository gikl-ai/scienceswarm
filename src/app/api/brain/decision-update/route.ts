import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { SourceRef } from "@/brain/types";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { buildMirroredBrainPagePath } from "@/lib/brain-artifact-path";
import { buildSourceRefCitationLines, buildSourceRefEvidenceLines } from "@/lib/capture/source-ref-lines";
import { isLocalRequest } from "@/lib/local-guard";
import { getCurrentUserHandle as _requireAttributionImport } from "@/lib/setup/gbrain-installer";
import { assertSafeProjectSlug } from "@/lib/state/project-manifests";
import { getBrainConfig, isErrorResponse } from "../_shared";
void _requireAttributionImport;

function isSourceRef(value: unknown): value is SourceRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === "string" && typeof candidate.ref === "string";
}

function dedupeSourceRefs(sourceRefs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const deduped: SourceRef[] = [];

  for (const sourceRef of sourceRefs) {
    const key = `${sourceRef.kind}:${sourceRef.ref}:${sourceRef.hash ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(sourceRef);
  }

  return deduped;
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return configOrError;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const project = typeof body.project === "string" ? body.project.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const sourceRefs = Array.isArray(body.sourceRefs)
    ? body.sourceRefs.filter(isSourceRef)
    : [];

  if (!slug) {
    return Response.json({ error: "slug is required" }, { status: 400 });
  }
  if (!project) {
    return Response.json({ error: "project is required" }, { status: 400 });
  }
  if (!content) {
    return Response.json({ error: "content is required" }, { status: 400 });
  }

  const safeProject = assertSafeProjectSlug(project);
  const decisionPath = buildMirroredBrainPagePath(slug, "decision");
  if (!decisionPath) {
    return Response.json({ error: "Could not resolve decision path" }, { status: 400 });
  }

  const absolutePath = path.join(configOrError.root, decisionPath);

  try {
    const existing = await readFile(absolutePath, "utf-8");
    const parsed = matter(existing);
    const frontmatter = (parsed.data ?? {}) as Record<string, unknown>;

    if (frontmatter.type !== "decision") {
      return Response.json({ error: "Only decision pages can be amended" }, { status: 400 });
    }
    if (typeof frontmatter.project === "string" && frontmatter.project !== safeProject) {
      return Response.json({ error: "Decision project does not match the active project" }, { status: 400 });
    }

    const existingSourceRefs = Array.isArray(frontmatter.source_refs)
      ? frontmatter.source_refs.filter(isSourceRef)
      : [];
    const mergedSourceRefs = dedupeSourceRefs([...existingSourceRefs, ...sourceRefs]);
    const nextFrontmatter = {
      ...frontmatter,
      project: safeProject,
      source_refs: mergedSourceRefs,
      updated_at: new Date().toISOString(),
    };

    const bodyParts = [parsed.content.trimEnd()];
    if (!/\n## Updates\s*$/m.test(parsed.content) && !parsed.content.includes("\n## Updates\n")) {
      bodyParts.push("", "## Updates");
    }

    const evidenceLines = buildSourceRefEvidenceLines(sourceRefs);
    const citationLines = buildSourceRefCitationLines(sourceRefs);
    bodyParts.push(
      "",
      `### ${new Date().toISOString().slice(0, 16).replace("T", " ")} update`,
      "",
      content,
    );
    if (evidenceLines.length > 0) {
      bodyParts.push("", "Evidence considered:", ...evidenceLines);
    }
    if (citationLines.length > 0) {
      bodyParts.push("", ...citationLines);
    }

    const nextMarkdown = matter.stringify(bodyParts.join("\n"), nextFrontmatter);
    await writeFile(absolutePath, nextMarkdown, "utf-8");
    await createInProcessGbrainClient().putPage(slug, nextMarkdown);

    return Response.json({
      ok: true,
      slug,
      path: decisionPath.replace(/\.md$/i, ""),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Decision update failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
