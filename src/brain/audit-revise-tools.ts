/**
 * Audit-and-revise MCP tool handlers.
 *
 * Audit-and-revise adds four capability tools to the ScienceSwarm MCP surface:
 *
 *   - resolve_artifact(project, hint?) → slug | { multiple: [slug] }
 *   - read_artifact(slug)              → { type, title, body, links }
 *   - link_artifact(from, to, relation)→ { ok }
 *   - critique_artifact(slug, style?)  → { critique_slug, brief, severity_counts }
 *
 * The handlers in this file are framework-agnostic: they take a `ToolDeps`
 * bag (brain store + gbrain CLI client + critique client) so tests can
 * substitute fakes without starting the real MCP server. `src/brain/mcp-
 * server.ts` registers thin adapters that bind the real dependencies.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";

import {
  CritiqueFrontmatterSchema,
  LinkRelationSchema,
  type CritiqueFrontmatter,
  type LinkRelation,
} from "./audit-revise-schema";
import type { BrainPage, BrainStore } from "./store";
import { getBrainStore } from "./store";
import type { GbrainClient } from "./gbrain-client";
import { createInProcessGbrainClient } from "./in-process-gbrain-client";
import {
  fetchStructuredCritiqueByJobId,
  submitStructuredCritique,
  type StructuredCritiqueStyleProfile,
  type SubmitCritiqueResult,
} from "@/lib/structured-critique-client";
import { normalizeStructuredCritiqueResultPayload } from "@/lib/structured-critique-schema";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import {
  getScienceSwarmProjectsRoot,
} from "@/lib/scienceswarm-paths";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";

/**
 * Wall-clock deadline the MCP `critique_artifact` handler waits for
 * hosted Descartes to finish. Real runs can reach Pass 5 + Explorer +
 * GraphFacts in the 15-25 min range on hostings with CPU-only inference,
 * so we default to 30 minutes and let operators override via
 * `STRUCTURED_CRITIQUE_TIMEOUT_MS` in the env.
 */
export const STRUCTURED_CRITIQUE_TOOL_TIMEOUT_MS = (() => {
  const raw = process.env.STRUCTURED_CRITIQUE_TIMEOUT_MS;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 30 * 60 * 1000;
})();

// ---------------------------------------------------------------------------
// Dependency bag — injected at handler creation so tests can swap fakes.
// ---------------------------------------------------------------------------

export interface CritiqueSubmitter {
  submit(input: {
    bytes: Uint8Array;
    filename: string;
    styleProfile: StructuredCritiqueStyleProfile;
    timeoutMs?: number;
  }): Promise<SubmitCritiqueResult>;
}

export interface ToolDeps {
  brain: BrainStore;
  gbrain: GbrainClient;
  critique: CritiqueSubmitter;
  /** Override so tests can hand back deterministic bytes for a slug. */
  loadPaperBytes?: (slug: string, page: BrainPage) => Promise<Uint8Array>;
  /** Clock override for deterministic frontmatter. */
  now?: () => Date;
}

/**
 * Real-dependencies builder used by `mcp-server.ts`. Tests construct their
 * own `ToolDeps` and never call this.
 */
export function buildDefaultToolDeps(): ToolDeps {
  return {
    brain: getBrainStore(),
    // In-process gbrain client — reads and writes share the same
    // PGLite connection as `getBrainStore()`, so there is no lock
    // conflict when the audit-revise handler reads the paper and
    // then writes the critique in the same process.
    gbrain: createInProcessGbrainClient(),
    critique: createLiveCritiqueSubmitter(),
    now: () => new Date(),
  };
}

/**
 * The hosted Descartes critique endpoint uses an async job pattern:
 *
 *   POST /structured-critique  →  { id, status: "PENDING", result: null }
 *   GET  /structured-critique/{id}  →  { id, status: "RUNNING" | "COMPLETED" | "CANCELLED" | "FAILED", result }
 *
 * The pre-existing `/api/structured-critique` dashboard route leaves
 * polling to the frontend, but the MCP `critique_artifact` handler
 * needs the unwrapped result synchronously. This wrapper submits the
 * POST, detects a job handle, then polls GET until the job reaches a
 * terminal state (COMPLETED → unwrap `result`; FAILED/CANCELLED →
 * surface the error) or the wall-clock deadline expires.
 *
 * If the upstream returns a flat payload on the first POST (i.e. a
 * synchronous service), we pass it through unchanged so both shapes
 * are supported by one code path.
 */
function createLiveCritiqueSubmitter(): CritiqueSubmitter {
  return {
    async submit(input) {
      const timeoutMs = input.timeoutMs ?? STRUCTURED_CRITIQUE_TOOL_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;

      const first = await submitStructuredCritique({
        file: {
          bytes: input.bytes,
          filename: input.filename,
          contentType: "application/pdf",
        },
        styleProfile: input.styleProfile,
        timeoutMs,
      });
      if (!first.ok) return first;

      const firstPayload = first.payload as Record<string, unknown> | null;
      const maybeJob = extractJobHandle(firstPayload);
      if (!maybeJob) {
        // Synchronous upstream — the POST response already contains
        // `findings` / `author_feedback` / `report_markdown`. Pass
        // through unchanged.
        return first;
      }

      // Async upstream. Poll until the job reaches a terminal state.
      const pollIntervalMs = 3_000;
      // Fast-path COMPLETED on first response (unusual but harmless).
      const firstTerminal = evaluateJobPayload(firstPayload);
      if (firstTerminal) return firstTerminal;

      while (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        const poll = await fetchStructuredCritiqueByJobId(maybeJob.id, {
          timeoutMs: Math.max(1_000, deadline - Date.now()),
        });
        if (!poll.ok) return poll;
        const terminal = evaluateJobPayload(
          poll.payload as Record<string, unknown> | null,
        );
        if (terminal) return terminal;
      }

      return {
        ok: false,
        status: 504,
        error: `the critique service did not respond after ${Math.round(timeoutMs / 1000)} seconds — try again or check the service status.`,
      };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJobHandle(
  payload: Record<string, unknown> | null,
): { id: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const id = payload.id;
  const status = payload.status;
  if (typeof id !== "string" || id.length === 0) return null;
  // Job wrappers always carry a non-null `status` string even when
  // they also happen to have a `result` field.
  if (typeof status !== "string") return null;
  return { id };
}

function evaluateJobPayload(
  payload: Record<string, unknown> | null,
): SubmitCritiqueResult | null {
  if (!payload || typeof payload !== "object") return null;
  const status =
    typeof payload.status === "string" ? payload.status.toUpperCase() : "";
  if (status === "COMPLETED") {
    const result = payload.result;
    if (result && typeof result === "object") {
      return { ok: true, status: 200, payload: result };
    }
    return {
      ok: false,
      status: 502,
      error: "critique service reported COMPLETED but returned no result",
    };
  }
  if (status === "FAILED" || status === "CANCELLED") {
    const errorMessage = readTerminalJobError(payload);
    return { ok: false, status: 500, error: errorMessage };
  }
  return null;
}

function readTerminalJobError(payload: Record<string, unknown>): string {
  const errorMessage =
    typeof payload.error_message === "string"
      ? payload.error_message.trim()
      : "";
  if (errorMessage) return errorMessage;

  const error = payload.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (error && typeof error === "object") {
    const userFacingMessage = (
      error as { user_facing_message?: unknown }
    ).user_facing_message;
    if (
      typeof userFacingMessage === "string" &&
      userFacingMessage.trim().length > 0
    ) {
      return userFacingMessage;
    }
  }
  return "critique service job failed";
}

// ---------------------------------------------------------------------------
// Zod schemas for the public tool params.
// ---------------------------------------------------------------------------

export const ResolveArtifactSchema = z.object({
  project: z.string().min(1),
  hint: z.string().optional(),
});
export const ReadArtifactSchema = z.object({
  slug: z.string().min(1),
});
export const LinkArtifactSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relation: LinkRelationSchema,
});
export const CritiqueArtifactSchema = z.object({
  slug: z.string().min(1),
  style: z
    .enum(["professional", "referee", "internal_red_team"])
    .optional(),
});

export type ResolveArtifactParams = z.infer<typeof ResolveArtifactSchema>;
export type ReadArtifactParams = z.infer<typeof ReadArtifactSchema>;
export type LinkArtifactParams = z.infer<typeof LinkArtifactSchema>;
export type CritiqueArtifactParams = z.infer<typeof CritiqueArtifactSchema>;

// ---------------------------------------------------------------------------
// Result shapes returned from each handler.
// ---------------------------------------------------------------------------

export interface ResolveArtifactResult {
  slug?: string;
  multiple?: string[];
  message?: string;
}

export interface ReadArtifactResult {
  slug: string;
  type: string;
  title: string;
  body: string;
  links: string[];
  frontmatter: Record<string, unknown>;
}

export interface LinkArtifactResult {
  ok: true;
  from: string;
  to: string;
  relation: LinkRelation;
}

export interface CritiqueArtifactResult {
  critique_slug: string;
  brief: string;
  severity_counts: Record<string, number>;
  descartes_wall_time_s?: number;
  raw_descartes_findings_count?: number;
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

export async function resolveArtifact(
  deps: ToolDeps,
  params: ResolveArtifactParams,
): Promise<ResolveArtifactResult> {
  const { project, hint } = ResolveArtifactSchema.parse(params);
  const pages = await deps.brain.listPages({ limit: 5000 });
  const projectPages = pages.filter((page) => page.frontmatter?.project === project);
  const candidates = projectPages
    .filter((page) => artifactMatchesHint(page, hint))
    .sort((left, right) => left.path.localeCompare(right.path));

  if (candidates.length === 0) {
    return {
      message: `No artifacts matched project '${project}'${hint ? ` with hint '${hint}'` : ""}.`,
    };
  }

  const exact = exactArtifactMatches(candidates, hint);
  if (exact.length === 1) {
    return { slug: exact[0].path };
  }

  if (candidates.length === 1) {
    return { slug: candidates[0].path };
  }

  return {
    multiple: candidates.slice(0, 10).map((c) => c.path),
  };
}

function artifactMatchesHint(
  page: BrainPage,
  hint: string | undefined,
): boolean {
  if (!hint || hint.trim().length === 0) return true;
  const normalizedHint = normalizeArtifactSearchValue(hint);
  if (!normalizedHint) return true;
  const fm = page.frontmatter ?? {};
  const sourceFilename =
    typeof fm.source_filename === "string" ? fm.source_filename : "";
  const haystack = [
    page.path,
    page.title,
    page.type,
    String(fm.type ?? ""),
    sourceFilename,
    sourceFilename.replace(/\.[^.]+$/, ""),
  ]
    .map(normalizeArtifactSearchValue)
    .filter(Boolean);
  return haystack.some((value) => value.includes(normalizedHint));
}

function exactArtifactMatches(
  pages: BrainPage[],
  hint: string | undefined,
): BrainPage[] {
  if (!hint || hint.trim().length === 0) return [];
  const normalizedHint = normalizeArtifactSearchValue(hint);
  return pages.filter((page) => {
    const fm = page.frontmatter ?? {};
    const sourceFilename =
      typeof fm.source_filename === "string" ? fm.source_filename : "";
    return [
      page.path,
      sourceFilename,
      sourceFilename.replace(/\.[^.]+$/, ""),
    ]
      .map(normalizeArtifactSearchValue)
      .some((value) => value === normalizedHint);
  });
}

function normalizeArtifactSearchValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^gbrain:/, "")
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export async function readArtifact(
  deps: ToolDeps,
  params: ReadArtifactParams,
): Promise<ReadArtifactResult> {
  const { slug } = ReadArtifactSchema.parse(params);
  const page = await deps.brain.getPage(slug);
  if (!page) {
    throw new Error(`read_artifact: no page for slug '${slug}'`);
  }
  const frontmatter = (page.frontmatter ?? {}) as Record<string, unknown>;
  const links = extractLinks(frontmatter, page.content);
  return {
    slug,
    type: String(frontmatter.type ?? page.type ?? "unknown"),
    title: page.title,
    body: page.content,
    links,
    frontmatter,
  };
}

function extractLinks(
  frontmatter: Record<string, unknown>,
  content: string,
): string[] {
  const out = new Set<string>();
  // Frontmatter-declared structural links (audit-revise v1 convention).
  for (const key of [
    "parent",
    "critique",
    "plan",
    "revision",
    "cover_letter_for",
  ]) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.length > 0) out.add(value);
  }
  if (Array.isArray(frontmatter.artifact_files)) {
    for (const entry of frontmatter.artifact_files) {
      if (typeof entry === "string") out.add(entry);
    }
  }
  // Body-level [[slug]] wikilinks.
  for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    out.add(match[1]);
  }
  return Array.from(out);
}

export async function linkArtifact(
  deps: ToolDeps,
  params: LinkArtifactParams,
): Promise<LinkArtifactResult> {
  const { from, to, relation } = LinkArtifactSchema.parse(params);
  await deps.gbrain.linkPages(from, to, { linkType: relation });
  return { ok: true, from, to, relation };
}

export async function critiqueArtifact(
  deps: ToolDeps,
  params: CritiqueArtifactParams,
): Promise<CritiqueArtifactResult> {
  const { slug, style } = CritiqueArtifactSchema.parse(params);
  const styleProfile = (style ??
    "professional") as StructuredCritiqueStyleProfile;

  const page = await deps.brain.getPage(slug);
  if (!page) {
    throw new Error(`critique_artifact: no paper page for slug '${slug}'`);
  }
  const fm = (page.frontmatter ?? {}) as Record<string, unknown>;
  if (fm.type !== "paper") {
    throw new Error(
      `critique_artifact: page '${slug}' has type '${fm.type}', not 'paper'`,
    );
  }
  const sourceFilename =
    typeof fm.source_filename === "string" && fm.source_filename.length > 0
      ? fm.source_filename
      : `${slug}.pdf`;

  // The upload route dual-writes original bytes under
  // SCIENCESWARM_DIR/projects/<project>/<source_filename>. For tests, the
  // caller can inject `loadPaperBytes` to avoid hitting the filesystem.
  const bytes = await loadPaperBytes(deps, slug, page);

  const submitStart = Date.now();
  const upstream = await deps.critique.submit({
    bytes,
    filename: sourceFilename,
    styleProfile,
    timeoutMs: STRUCTURED_CRITIQUE_TOOL_TIMEOUT_MS,
  });
  const wallMs = Date.now() - submitStart;

  if (!upstream.ok) {
    throw new Error(upstream.error);
  }

  if (!upstream.payload || typeof upstream.payload !== "object") {
    throw new Error("critique_artifact: upstream returned no payload");
  }

  const payload = normalizeStructuredCritiqueResultPayload(upstream.payload);
  const rawFindings = payload.findings;
  const severityCounts = computeSeverityCounts(rawFindings);
  const brief = buildBrief(payload);

  const critiqueSlug = `${slug}-critique`;
  const now = (deps.now ? deps.now() : new Date())
    .toISOString()
    .replace(/\.\d+/, "");
  const userHandle = getCurrentUserHandle();
  const project =
    typeof fm.project === "string" && fm.project.length > 0
      ? fm.project
      : slug;

  const frontmatter: CritiqueFrontmatter = CritiqueFrontmatterSchema.parse({
    type: "critique",
    project,
    parent: slug,
    source_filename: typeof fm.source_filename === "string"
      ? fm.source_filename
      : undefined,
    uploaded_at: now,
    uploaded_by: userHandle,
    style_profile: styleProfile,
    finding_count: rawFindings.length,
    raw_descartes_findings_count: rawFindings.length,
    descartes_wall_time_s: Math.round(wallMs / 1000),
  });

  const body = buildCritiqueBody({
    parentSlug: slug,
    payload,
    brief,
    severityCounts,
  });
  const markdown = matter.stringify(body, frontmatter);
  await deps.gbrain.putPage(critiqueSlug, markdown);

  // Plan §2.2 step 7: link the critique back to its parent paper via the
  // `audited_by` relation so the gbrain graph walk finds it. The
  // frontmatter `parent` field alone is not a first-class gbrain link.
  // Any downstream consumer that uses `gbrain get_links <paper-slug>`
  // would otherwise see nothing after the critique is materialised.
  await deps.gbrain.linkPages(slug, critiqueSlug, {
    linkType: "audited_by",
  });

  return {
    critique_slug: critiqueSlug,
    brief,
    severity_counts: severityCounts,
    descartes_wall_time_s: Math.round(wallMs / 1000),
    raw_descartes_findings_count: rawFindings.length,
  };
}

async function loadPaperBytes(
  deps: ToolDeps,
  slug: string,
  page: BrainPage,
): Promise<Uint8Array> {
  if (deps.loadPaperBytes) {
    return deps.loadPaperBytes(slug, page);
  }
  const fm = (page.frontmatter ?? {}) as Record<string, unknown>;
  const rawProject =
    typeof fm.project === "string" && fm.project.length > 0
      ? fm.project
      : slug;
  const rawSourceFilename =
    typeof fm.source_filename === "string" && fm.source_filename.length > 0
      ? fm.source_filename
      : `${slug}.pdf`;

  // Every read path must sanitize frontmatter-derived values before
  // touching the filesystem. Greptile P1 on PR #283: a crafted
  // `project` or `source_filename` could otherwise escape the projects
  // directory via path.join. We run the same slug validator the
  // workspace upload route uses and forbid any path separator in the
  // filename. If either check fails we throw with a typed error instead
  // of silently reading a wrong file.
  let project: string;
  try {
    project = assertSafeProjectSlug(rawProject);
  } catch (error) {
    if (error instanceof InvalidSlugError) {
      throw new Error(
        `critique_artifact: page '${slug}' has an invalid project slug '${rawProject}': ${error.message}`,
      );
    }
    throw error;
  }
  if (
    rawSourceFilename.includes("/") ||
    rawSourceFilename.includes("\\") ||
    rawSourceFilename.includes("..")
  ) {
    throw new Error(
      `critique_artifact: page '${slug}' source_filename '${rawSourceFilename}' must not contain path separators`,
    );
  }

  const projectsRoot = getScienceSwarmProjectsRoot();
  const filePath = path.resolve(projectsRoot, project, rawSourceFilename);
  const allowedRoot = path.resolve(projectsRoot);
  if (
    filePath !== allowedRoot &&
    !filePath.startsWith(`${allowedRoot}${path.sep}`)
  ) {
    throw new Error(
      `critique_artifact: resolved path '${filePath}' escapes the projects root`,
    );
  }
  return new Uint8Array(await fs.readFile(filePath));
}

function computeSeverityCounts(findings: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of findings) {
    if (!entry || typeof entry !== "object") continue;
    const severity = (entry as { severity?: unknown }).severity;
    const key =
      typeof severity === "string" && severity.length > 0
        ? severity.toLowerCase()
        : "unrated";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function buildBrief(payload: Record<string, unknown>): string {
  const author = payload.author_feedback;
  if (author && typeof author === "object") {
    const overall = (author as { overall_summary?: unknown }).overall_summary;
    if (typeof overall === "string" && overall.trim().length > 0) {
      return overall.trim().slice(0, 800);
    }
  }
  const report = payload.report_markdown;
  if (typeof report === "string" && report.trim().length > 0) {
    return report.trim().split("\n\n").slice(0, 2).join("\n\n").slice(0, 800);
  }
  return "Critique completed; see the full page for details.";
}

interface CritiqueBodyArgs {
  parentSlug: string;
  payload: Record<string, unknown>;
  brief: string;
  severityCounts: Record<string, number>;
}

function buildCritiqueBody(args: CritiqueBodyArgs): string {
  const { parentSlug, payload, brief, severityCounts } = args;
  const severityLines = Object.entries(severityCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([severity, count]) => `- **${severity}**: ${count}`);
  const rawBlock = JSON.stringify(payload, null, 2);
  // Per plan §2.2 / principle 6 we persist the upstream response verbatim
  // inside the page body. The agent and the reasoning page both consume
  // the JSON through the existing renderer components.
  return [
    `# Critique for [[${parentSlug}]]`,
    "",
    "## Brief",
    "",
    brief,
    "",
    "## Severity counts",
    "",
    severityLines.length > 0 ? severityLines.join("\n") : "- unrated: 0",
    "",
    "## Raw Descartes response",
    "",
    "```json",
    rawBlock,
    "```",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Digest helpers — exported for tests asserting deterministic slug rules.
// ---------------------------------------------------------------------------

export function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
