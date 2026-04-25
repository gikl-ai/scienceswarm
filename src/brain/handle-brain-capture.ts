/**
 * brain_capture — MCP tool handler.
 *
 * Thin proxy over gbrain's put_page: ScienceSwarm builds a markdown page
 * with frontmatter + inline [Source:] provenance and delegates the write
 * to the gbrain CLI. gbrain owns chunking, embeddings, tag reconciliation,
 * and content-hash dedupe. This handler does NOT touch the capture pipeline
 * in src/lib/capture/ — it is a parallel, gbrain-backed path.
 *
 * Dependency-injected gbrain client so tests stay pure unit tests.
 */

import { randomBytes } from "crypto";
import matter from "gray-matter";
import type { GbrainClient, GbrainPutError } from "./gbrain-client";
import type { CaptureKind } from "./types";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import {
  validateRuntimeGbrainProvenance,
  type RuntimeGbrainProvenance,
} from "@/lib/runtime-hosts/gbrain-writeback";

export type BrainCaptureKind = CaptureKind;

export interface BrainCaptureParams {
  content: string;
  kind?: BrainCaptureKind;
  title?: string;
  project?: string;
  tags?: string[];
  channel?: string;
  userId?: string;
  runtimeOriginated?: boolean;
  runtimeSessionId?: string;
  runtimeHostId?: string;
  runtimeProvenance?: RuntimeGbrainProvenance;
}

export type BrainCaptureToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
};

const CAPTURE_HOME_BY_KIND: Partial<Record<BrainCaptureKind, string>> = {
  survey: "surveys",
  method: "methods",
  original_synthesis: "originals",
  research_packet: "packets",
  overnight_journal: "journals",
};

/** Local slugify — intentionally decoupled from capture/materialize-memory.ts. */
function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return cleaned || "capture";
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function shortHash(): string {
  return randomBytes(3).toString("hex");
}

function buildCaptureSlug(
  kind: BrainCaptureKind | undefined,
  date: string,
  titleSource: string,
  hash: string,
): string {
  const baseSlug = `${date}-${slugify(titleSource)}-${hash}`;
  const home = kind ? CAPTURE_HOME_BY_KIND[kind] : undefined;
  return home ? `${home}/${baseSlug}` : baseSlug;
}

export interface BuiltCapturePage {
  slug: string;
  markdown: string;
  title: string;
  date: string;
}

/** Pure builder — exported for unit tests that want to assert the payload. */
export function buildCapturePage(
  params: BrainCaptureParams,
  now: Date = new Date(),
  hash: string = shortHash(),
  userHandle: string = getCurrentUserHandle(),
): BuiltCapturePage {
  const date = formatDate(now);
  const titleSource =
    params.title && params.title.trim().length > 0
      ? params.title.trim()
      : firstNonEmptyLine(params.content)
          .replace(/^#+\s*/, "")
          .slice(0, 60);
  const title = titleSource || "Capture";
  const slug = buildCaptureSlug(params.kind, date, titleSource, hash);

  const frontmatter: Record<string, unknown> = {
    title,
    date,
  };
  if (params.kind) {
    frontmatter.kind = params.kind;
    frontmatter.type = params.kind;
  }
  if (params.project) frontmatter.project = params.project;
  if (params.tags && params.tags.length > 0) frontmatter.tags = params.tags;
  if (params.channel) frontmatter.channel = params.channel;
  if (params.userId) frontmatter.userId = params.userId;
  if (params.runtimeProvenance) {
    frontmatter.runtime_gbrain_provenance = {
      runtimeSessionId: params.runtimeProvenance.runtimeSessionId,
      hostId: params.runtimeProvenance.hostId,
      sourceArtifactId: params.runtimeProvenance.sourceArtifactId,
      promptHash: params.runtimeProvenance.promptHash,
      inputFileRefs: params.runtimeProvenance.inputFileRefs,
      approvalState: params.runtimeProvenance.approvalState,
    };
  }

  const sourceLocator = `${params.channel ?? "mcp"}:${params.userId ?? "unknown"}`;
  const sourceLine = `[Source: ${userHandle} via ${sourceLocator}, ${date}]`;

  // If the content already opens with its own markdown heading (any level),
  // skip the prepended `# ${title}` to avoid storing two stacked headings.
  const trimmedContent = params.content.trim();
  const contentOpensWithHeading = /^#+\s/.test(trimmedContent);

  const body = [
    ...(contentOpensWithHeading ? [] : [`# ${title}`, ""]),
    trimmedContent,
    "",
    sourceLine,
    "",
  ].join("\n");

  const markdown = matter.stringify(body, frontmatter);
  return { slug, markdown, title, date };
}

export interface BrainCaptureHandlerDeps {
  client: GbrainClient;
  /** Override clock for tests. */
  now?: () => Date;
  /** Override random slug suffix for tests. */
  hash?: () => string;
}

function errorResponse(message: string): BrainCaptureToolResponse {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function validateRuntimeCapture(params: BrainCaptureParams): string | null {
  if (!params.runtimeOriginated) return null;
  if (!params.runtimeProvenance) {
    return "Runtime-originated gbrain_capture requires RuntimeGbrainProvenance.";
  }
  if (!params.runtimeSessionId || !params.runtimeHostId) {
    return "Runtime-originated gbrain_capture requires runtime session and host scope.";
  }

  const error = validateRuntimeGbrainProvenance({
    provenance: params.runtimeProvenance,
    runtimeSessionId: params.runtimeSessionId,
    hostId: params.runtimeHostId,
  });
  return error?.message ?? null;
}

export function createBrainCaptureHandler(
  deps: BrainCaptureHandlerDeps,
): (params: BrainCaptureParams) => Promise<BrainCaptureToolResponse> {
  return async function handleBrainCapture(params) {
    if (!params.content || params.content.trim() === "") {
      return errorResponse("Error: content is required and cannot be empty.");
    }
    const runtimeCaptureError = validateRuntimeCapture(params);
    if (runtimeCaptureError) {
      return errorResponse(`Error: ${runtimeCaptureError}`);
    }

    const now = deps.now ? deps.now() : new Date();
    const hash = deps.hash ? deps.hash() : shortHash();
    let page: BuiltCapturePage;
    try {
      page = buildCapturePage(params, now, hash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(`Error: ${message}`);
    }

    try {
      const { stdout, stderr } = await deps.client.putPage(page.slug, page.markdown);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "created_or_updated",
                slug: page.slug,
                title: page.title,
                date: page.date,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err) {
      const wrapped = err as GbrainPutError;
      if (wrapped?.code === "ENOENT") {
        return errorResponse(
          "Error: ScienceSwarm's repo-local gbrain CLI was not found. Run `npm ci` from the ScienceSwarm checkout so node_modules matches package-lock.json, then rerun setup if the brain has not been initialized.",
        );
      }
      const detail = wrapped?.stderr?.trim() || wrapped?.message || String(err);
      return errorResponse(`Error: gbrain put failed: ${detail}`);
    }
  };
}
