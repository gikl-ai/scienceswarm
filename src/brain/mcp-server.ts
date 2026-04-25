/**
 * Second Brain — MCP Server
 *
 * Wraps brain tooling with MCP handlers:
 *   brain_init, brain_search, brain_read, brain_status,
 *   brain_guide, brain_ripple, brain_capture, brain_maintenance,
 *   brain_project_organize, brain_import_registry
 *
 * Capture writes flow through `brain_capture`, which proxies to gbrain's
 * `put_page` via the gbrain subprocess. The legacy `brain_ingest` /
 * `brain_observe` custom-pipeline tools were removed in favor of gbrain
 * (PR #239, Phase B).
 *
 * Uses @modelcontextprotocol/sdk McpServer for the high-level API.
 * Designed to be run as a standalone process via stdio transport.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { resolve } from "path";
import matter from "gray-matter";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getScienceSwarmBrainRoot, resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import { loadBrainConfig } from "./config";
import { generateHealthReportWithGbrain } from "./brain-health";
import { initBrainWithInstaller } from "./init";
import { countPages, search } from "./search";
import { buildScienceSwarmMaintenanceContext } from "./maintenance-context";
import { buildBrainMaintenancePlan } from "./maintenance-recommendations";
import { ripple } from "./ripple";
import {
  getMonthCost,
  isBudgetExceeded,
  getRecentEvents,
} from "./cost";
import { createLLMClient } from "./llm";
import { CAPTURE_KINDS, type BrainConfig, type SearchDetail } from "./types";
import type { LLMClient } from "./llm";
import { readBrainFile } from "./source";
import { buildGuideBriefing } from "./briefing";
import { buildProjectImportRegistry } from "./import-registry";
import { buildProjectOrganizerReadout } from "./project-organizer";
import { createGbrainClient, type GbrainClient } from "./gbrain-client";
import {
  createBrainCaptureHandler,
  type BrainCaptureParams,
  type BrainCaptureToolResponse,
} from "./handle-brain-capture";
import {
  approveRevisionPlan,
  cancelJob as cancelJobHelper,
  draftRevisionPlan,
} from "./audit-revise-plan";
import {
  buildDefaultToolDeps,
  critiqueArtifact,
  linkArtifact,
  readArtifact,
  resolveArtifact,
} from "./audit-revise-tools";
import {
  buildDefaultJobDeps,
  checkJob,
  runJob,
  type JobDeps,
} from "@/lib/jobs/run-job";
import {
  assertSafeProjectSlug,
  InvalidSlugError,
} from "@/lib/state/project-manifests";
import {
  runResearchLandscape,
  type ResearchLandscapeSource,
} from "@/lib/research-packets";
import { arxivFetch, arxivSearch } from "@/lib/skills/db-arxiv";
import { biorxivFetch, biorxivSearch } from "@/lib/skills/db-biorxiv";
import { chemblFetch, chemblSearch } from "@/lib/skills/db-chembl";
import {
  clinicalTrialsFetch,
  clinicalTrialsSearch,
} from "@/lib/skills/db-clinicaltrials";
import { crossrefFetch, crossrefSearch } from "@/lib/skills/db-crossref";
import {
  materialsProjectFetch,
  materialsProjectSearch,
} from "@/lib/skills/db-materials-project";
import { openalexFetch, openalexSearch } from "@/lib/skills/db-openalex";
import { orcidFetch, orcidSearch } from "@/lib/skills/db-orcid";
import { pdbFetch, pdbSearch } from "@/lib/skills/db-pdb";
import { pubmedFetch, pubmedSearch } from "@/lib/skills/db-pubmed";
import {
  semanticScholarFetch,
  semanticScholarSearch,
} from "@/lib/skills/db-semantic-scholar";
import { uniprotFetch, uniprotSearch } from "@/lib/skills/db-uniprot";
import { getBrainStore, type BrainPage } from "./store";
import { getCurrentUserHandle } from "@/lib/setup/gbrain-installer";
import { registerRuntimeMcpTools } from "@/lib/runtime-hosts/mcp/server";

// ── Tool Handler Implementations ──────────────────────────
// Exported for testability without MCP transport.

export async function handleBrainInit(params: {
  root?: string;
  name?: string;
  field?: string;
}): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const root =
    resolveConfiguredPath(params.root) ??
    resolveConfiguredPath(process.env.BRAIN_ROOT) ??
    getScienceSwarmBrainRoot();

  try {
    const result = await initBrainWithInstaller({
      root: resolve(root),
      name: params.name,
      field: params.field,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Brain initialization failed";
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${message}` }],
    };
  }
}

export async function handleBrainSearch(
  config: BrainConfig,
  params: { query: string; mode?: string; limit?: number; detail?: string },
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  const validModes = ["grep", "index", "list", "qmd"];
  const mode = params.mode && validModes.includes(params.mode)
    ? (params.mode as "grep" | "index" | "list" | "qmd")
    : "grep";
  const validDetails = ["low", "medium", "high"];
  const detail =
    params.detail && validDetails.includes(params.detail)
      ? (params.detail as SearchDetail)
      : undefined;

  if (params.detail && detail == null) {
    return {
      content: [
        {
          type: "text",
          text: "Error: detail must be one of low, medium, or high.",
        },
      ],
      isError: true,
    };
  }

  if (mode !== "list" && (!params.query || params.query.trim() === "")) {
    return {
      content: [{ type: "text", text: "Error: query is required and cannot be empty." }],
      isError: true,
    };
  }

  const results = await search(config, {
    query: params.query ?? "",
    mode,
    limit: params.limit ?? 10,
    detail,
  });

  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
  };
}

export async function handleBrainRead(
  config: BrainConfig,
  params: { path: string }
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const requestedPath = params.path?.trim() ?? "";
  if (!requestedPath) {
    return {
      content: [{ type: "text", text: "Error: path is required and cannot be empty." }],
      isError: true,
    };
  }

  // Path traversal protection: resolve and verify within brain root
  const resolvedRoot = resolve(config.root);
  const resolvedPath = resolve(resolvedRoot, requestedPath);

  if (!resolvedPath.startsWith(resolvedRoot + "/") && resolvedPath !== resolvedRoot) {
    return {
      content: [{ type: "text", text: "Error: path traversal detected. Path must be within brain root." }],
      isError: true,
    };
  }

  if (existsSync(resolvedPath)) {
    if (!statSync(resolvedPath).isFile()) {
      return {
        content: [{ type: "text", text: `Error: path is a directory, not a file: ${requestedPath}` }],
        isError: true,
      };
    }

    const fileContent = await readBrainFile(resolvedPath);
    return {
      content: [{ type: "text", text: fileContent }],
    };
  }

  const storeRead = await readGbrainPageForMcp(config, requestedPath);
  if (storeRead.page) {
    return {
      content: [{ type: "text", text: formatBrainPageForMcpRead(storeRead.page) }],
    };
  }

  const lookupHint = storeRead.error
    ? ` gbrain lookup also failed: ${storeRead.error}`
    : " Use gbrain_search first and pass the returned path exactly, such as wiki/entities/papers/example.md or example.md.";
  return {
    content: [{ type: "text", text: `Error: file not found and gbrain page not found: ${requestedPath}.${lookupHint}` }],
    isError: true,
  };
}

async function readGbrainPageForMcp(
  config: BrainConfig,
  requestedPath: string,
): Promise<{ page: BrainPage | null; error: string | null }> {
  try {
    const page = await getBrainStore({ root: resolve(config.root) }).getPage(requestedPath);
    return { page, error: null };
  } catch (error) {
    return {
      page: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatBrainPageForMcpRead(page: BrainPage): string {
  const frontmatter = {
    ...page.frontmatter,
    type: page.frontmatter.type ?? page.type,
    title: page.frontmatter.title ?? page.title,
  };
  return [
    `<!-- gbrain page: ${page.path} -->`,
    matter.stringify(page.content, frontmatter).trim(),
  ].join("\n");
}

export async function handleBrainStatus(
  config: BrainConfig
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const monthCost = getMonthCost(config);
  const budgetExceeded = isBudgetExceeded(config);
  const recentEvents = getRecentEvents(config, undefined, 10);

  // Page count via the gbrain-backed store (Phase B Track C).
  const pageCount = await countPages(config);

  const status = {
    monthCost,
    budgetExceeded,
    recentEvents,
    pageCount,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
  };
}

export async function handleBrainMaintenance(
  config: BrainConfig,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const report = await generateHealthReportWithGbrain(config);
  const plan = buildBrainMaintenancePlan(
    report,
    buildScienceSwarmMaintenanceContext(report, process.env, config.root),
  );
  return {
    content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
  };
}

export async function handleBrainProjectOrganize(
  config: BrainConfig,
  params: { project: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const safeProject = validateProjectSlug(params.project);
  if (typeof safeProject !== "string") {
    return safeProject;
  }

  const readout = await buildProjectOrganizerReadout({
    config,
    project: safeProject,
  });
  return {
    content: [{ type: "text", text: JSON.stringify(readout, null, 2) }],
  };
}

export async function handleBrainImportRegistry(
  config: BrainConfig,
  params: { project: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const safeProject = validateProjectSlug(params.project);
  if (typeof safeProject !== "string") {
    return safeProject;
  }

  const registry = await buildProjectImportRegistry({
    config,
    project: safeProject,
  });
  return {
    content: [{ type: "text", text: JSON.stringify(registry, null, 2) }],
  };
}

export async function handleResearchLandscape(
  config: BrainConfig,
  params: {
    query: string;
    exact_title?: string;
    project?: string;
    sources?: ResearchLandscapeSource[];
    per_source_limit?: number;
    retained_limit?: number;
    start_year?: number;
    end_year?: number;
    retry_count?: number;
  },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const query = params.query?.trim();
  if (!query) {
    return {
      content: [{ type: "text", text: "Error: query is required and cannot be empty." }],
      isError: true,
    };
  }

  let safeProject: string | undefined;
  if (params.project?.trim()) {
    const validated = validateProjectSlug(params.project);
    if (typeof validated !== "string") {
      return validated;
    }
    safeProject = validated;
  }

  try {
    const result = await runResearchLandscape({
      query,
      exactTitle: params.exact_title,
      project: safeProject,
      sources: params.sources,
      perSourceLimit: params.per_source_limit,
      retainedLimit: params.retained_limit,
      startYear: params.start_year,
      endYear: params.end_year,
      retryCount: params.retry_count,
    }, {
      brainRoot: config.root,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

export async function handleBrainGuide(
  config: BrainConfig,
  params: { focus?: string }
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const guideBriefing = await buildGuideBriefing(config, params.focus);

  const briefing = {
    ...guideBriefing,
    date: new Date().toISOString().slice(0, 10),
    focus: params.focus ?? "general",
    recentEvents: guideBriefing.recentChanges,
  };

  return {
    content: [{ type: "text", text: JSON.stringify(briefing, null, 2) }],
  };
}

function validateProjectSlug(
  rawProject: string | undefined,
): string | { content: Array<{ type: "text"; text: string }>; isError: true } {
  const trimmed = rawProject?.trim();
  if (!trimmed) {
    return {
      content: [{ type: "text", text: "Error: project is required and cannot be empty." }],
      isError: true,
    };
  }

  try {
    return assertSafeProjectSlug(trimmed);
  } catch (error) {
    if (error instanceof InvalidSlugError) {
      return {
        content: [{ type: "text", text: "Error: project must be a safe bare slug." }],
        isError: true,
      };
    }
    throw error;
  }
}

export async function handleBrainRipple(
  config: BrainConfig,
  llm: LLMClient,
  params: { pagePath: string; tags?: string[] }
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  if (!params.pagePath || params.pagePath.trim() === "") {
    return {
      content: [{ type: "text", text: "Error: pagePath is required and cannot be empty." }],
      isError: true,
    };
  }

  // Path traversal protection: resolve and verify within brain root
  const resolvedRoot = resolve(config.root);
  const absPath = resolve(resolvedRoot, params.pagePath);

  if (!absPath.startsWith(resolvedRoot + "/") && absPath !== resolvedRoot) {
    return {
      content: [{ type: "text", text: "Error: path traversal detected. pagePath must be within brain root." }],
      isError: true,
    };
  }

  if (!existsSync(absPath)) {
    return {
      content: [{ type: "text", text: `Error: page not found: ${params.pagePath}` }],
      isError: true,
    };
  }

  if (!statSync(absPath).isFile()) {
    return {
      content: [{ type: "text", text: `Error: path is a directory, not a file: ${params.pagePath}` }],
      isError: true,
    };
  }

  const pageContent = readFileSync(absPath, "utf-8");
  const result = await ripple(config, llm, {
    newPagePath: params.pagePath,
    newPageContent: pageContent,
    tags: params.tags ?? [],
  });

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

// ── brain_capture (gbrain proxy) ──────────────────────────

/**
 * Top-level handler export. Takes an injected `GbrainClient` so tests can
 * pass a fake and the real MCP binding below can pass a live one. Do NOT
 * call this without an explicit client — that would silently spawn a real
 * gbrain subprocess.
 */
export async function handleBrainCapture(
  client: GbrainClient,
  params: BrainCaptureParams,
): Promise<BrainCaptureToolResponse> {
  const handler = createBrainCaptureHandler({ client });
  return handler(params);
}

// ── Helpers ───────────────────────────────────────────────

function databaseToolErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const missingEnv = message.match(/^([A-Z0-9_]+) is not set\./);
  if (missingEnv) {
    return `${missingEnv[1]} is not set. Add ${missingEnv[1]}=... to .env and confirm /api/health reports it before using this database wrapper.`;
  }
  if (/^PDB ID must be/.test(message)) return message;
  const externalHttp = message.match(/^External database ([a-z_]+) returned HTTP (\d+)/);
  if (externalHttp) {
    return `External database ${externalHttp[1]} returned HTTP ${externalHttp[2]}. Try again later or use another source.`;
  }
  if (error instanceof SyntaxError) {
    return "External database returned malformed data. Try again later or use another source.";
  }
  return "Database wrapper failed. Try again later or use another source.";
}


// ── MCP Server Setup ──────────────────────────────────────

export function createBrainMcpServer(): McpServer {
  const server = new McpServer({
    name: "second-brain",
    version: "0.1.0",
  });

  // Lazily resolve config and LLM client — tools that need them will
  // call these getters, so the env can be set after server creation.
  let _config: BrainConfig | null = null;
  let _llm: LLMClient | null = null;

  function getConfig(): BrainConfig {
    if (!_config) {
      _config = loadBrainConfig();
    }
    if (!_config) {
      throw new Error(
        "Brain not configured. Initialize ~/.scienceswarm/brain or set BRAIN_ROOT and run brain_init."
      );
    }
    return _config;
  }

  function getLLM(): LLMClient {
    if (!_llm) {
      _llm = createLLMClient(getConfig());
    }
    return _llm;
  }

  // ── 1. brain_init ─────────────────────────────────────

  server.tool(
    "brain_init",
    "Initialize a new brain under SCIENCESWARM_DIR/brain or a custom BRAIN_ROOT",
    {
      root: z.string().optional().describe("Brain root directory (defaults to BRAIN_ROOT, SCIENCESWARM_DIR/brain, or ~/.scienceswarm/brain)"),
      name: z.string().optional().describe("Researcher name"),
      field: z.string().optional().describe("Research field"),
    },
    async (params) => {
      const result = await handleBrainInit(params);
      if (!result.isError) {
        // Clear cached config so subsequent tools pick up the new brain
        _config = null;
        _llm = null;
      }
      return result;
    },
  );

  // brain_ingest and brain_observe have been removed — capture now flows
  // through brain_capture (gbrain `put_page` proxy) registered below.

  // ── 2. brain_search ───────────────────────────────────

  server.tool(
    "brain_search",
    "Search the wiki",
    {
      query: z.string().describe("Search query"),
      mode: z
        .string()
        .optional()
        .describe("Search mode: grep, index, list, or qmd"),
      limit: z.number().optional().describe("Max results (default 10)"),
      detail: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Search detail: low, medium, or high"),
    },
    async (params) => handleBrainSearch(getConfig(), params),
  );

  // ── 3. brain_read ─────────────────────────────────────

  server.tool(
    "brain_read",
    "Read a specific wiki page",
    {
      path: z.string().describe("Relative path within brain root"),
    },
    async (params) => handleBrainRead(getConfig(), params),
  );

  // ── 4. brain_status ───────────────────────────────────

  server.tool(
    "brain_status",
    "Get brain health and stats",
    {},
    async () => handleBrainStatus(getConfig()),
  );

  // ── 5. brain_maintenance ──────────────────────────────

  server.tool(
    "brain_maintenance",
    "Get read-only gbrain maintenance recommendations",
    {},
    async () => handleBrainMaintenance(getConfig()),
  );

  // ── 6. brain_project_organize ─────────────────────────

  server.tool(
    "brain_project_organize",
    "Read-only organizer summary for one project: candidate threads, duplicate papers, and next steps",
    {
      project: z.string().describe("Project slug"),
    },
    async (params) => handleBrainProjectOrganize(getConfig(), params),
  );

  // ── 7. brain_import_registry ──────────────────────────

  server.tool(
    "brain_import_registry",
    "Read-only authoritative import registry for one project",
    {
      project: z.string().describe("Project slug"),
    },
    async (params) => handleBrainImportRegistry(getConfig(), params),
  );

  // ── 8. brain_guide ────────────────────────────────────

  server.tool(
    "brain_guide",
    "Daily research briefing",
    {
      focus: z.string().optional().describe("Focus area for reading suggestions"),
    },
    async (params) => handleBrainGuide(getConfig(), params),
  );

  // ── 9. brain_ripple ───────────────────────────────────

  server.tool(
    "brain_ripple",
    "Manually trigger ripple updates for a page",
    {
      pagePath: z.string().describe("Wiki page path (relative to brain root)"),
      tags: z.array(z.string()).optional().describe("Tags to guide ripple matching"),
    },
    async (params) => handleBrainRipple(getConfig(), getLLM(), params),
  );

  // ── 10. brain_capture ─────────────────────────────────
  // Thin proxy over gbrain's put_page. Does NOT use the processCapture /
  // materializeMemory path — gbrain owns the write pipeline (chunking,
  // embeddings, tag reconciliation).

  const brainCapture = createBrainCaptureHandler({ client: createGbrainClient() });
  const formatJson = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });
  const formatError = (error: unknown) => ({
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  });
  const formatDatabaseError = (error: unknown) => ({
    isError: true,
    content: [
      {
        type: "text" as const,
        text: databaseToolErrorMessage(error),
      },
    ],
  });

  server.tool(
    "brain_capture",
    "Capture a note, observation, decision, hypothesis, task, survey, method, original_synthesis, research_packet, or overnight_journal via gbrain's put_page",
    {
      content: z.string().describe("The capture body in markdown"),
      kind: z
        .enum(CAPTURE_KINDS)
        .optional()
        .describe("Capture kind — controls default tags and page type"),
      title: z
        .string()
        .optional()
        .describe("Optional explicit title (falls back to first non-empty line of content)"),
      project: z.string().optional().describe("Project slug to file under"),
      tags: z.array(z.string()).optional().describe("Tags to attach"),
      channel: z
        .string()
        .optional()
        .describe("Origin channel label for provenance (e.g. 'openclaw', 'web', 'telegram')"),
      userId: z.string().optional().describe("Originating user identifier"),
    },
    async (params) => brainCapture(params),
  );

  // ── Runtime MCP tools ─────────────────────────────────
  // Runtime-originated tools use token-bound wrappers. The legacy local
  // brain_* tools above remain available for ordinary MCP clients.
  registerRuntimeMcpTools(server, {
    brainSearch: (params) => handleBrainSearch(getConfig(), params),
    brainRead: (params) => handleBrainRead(getConfig(), params),
    brainCapture: (params) => brainCapture(params as BrainCaptureParams),
  });

  // ── 10-33. Scientific database wrapper tools ───────

  server.tool(
    "pubmed_fetch",
    "Fetch one PubMed paper by PMID or DOI and persist it as a gbrain entity page",
    {
      id: z.string().describe("PMID or DOI"),
      scheme: z.enum(["pmid", "doi"]).optional().describe("Identifier scheme"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await pubmedFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "pubmed_search",
    "Search PubMed and persist one search-result page without auto-persisting every hit",
    {
      query: z.string().describe("Free-text PubMed query"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      sort: z.enum(["relevance", "date_desc", "date_asc"]).optional(),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await pubmedSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "arxiv_fetch",
    "Fetch one arXiv paper by arXiv ID and persist it as a gbrain entity page",
    {
      id: z.string().describe("arXiv ID, e.g. 1706.03762 or arXiv:1706.03762"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await arxivFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "arxiv_search",
    "Search arXiv and persist one search-result page without auto-persisting every hit",
    {
      query: z.string().describe("Free-text arXiv query"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      sort: z.enum(["relevance", "date_desc", "date_asc"]).optional(),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await arxivSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "biorxiv_fetch",
    "Fetch one bioRxiv or medRxiv preprint by DOI and persist it as a gbrain entity page",
    {
      id: z.string().describe("bioRxiv or medRxiv DOI"),
      server: z.enum(["biorxiv", "medrxiv"]).optional().describe("Preprint server"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await biorxivFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "biorxiv_search",
    "Search recent bioRxiv or medRxiv preprints and persist one search-result page",
    {
      query: z.string().describe("Free-text query, optionally with YYYY-MM-DD/YYYY-MM-DD date range"),
      server: z.enum(["biorxiv", "medrxiv"]).optional().describe("Preprint server"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      cursor: z.string().optional().describe("bioRxiv API cursor returned by a prior search"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await biorxivSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "crossref_fetch",
    "Fetch one Crossref work by DOI and persist it as a gbrain entity page",
    {
      id: z.string().describe("DOI"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await crossrefFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "crossref_search",
    "Search Crossref works and persist one search-result page without auto-persisting every hit",
    {
      query: z.string().describe("Free-text Crossref query"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      sort: z.enum(["relevance", "date_desc", "date_asc"]).optional(),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await crossrefSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "openalex_fetch",
    "Fetch one OpenAlex work or author and persist it as a gbrain entity page",
    {
      id: z.string().describe("OpenAlex ID or URL"),
      entity_type: z.enum(["paper", "person"]).optional().describe("Entity type"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await openalexFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "openalex_search",
    "Search OpenAlex works or authors and persist one search-result page",
    {
      query: z.string().describe("Free-text OpenAlex query"),
      entity_type: z.enum(["paper", "person"]).optional().describe("Entity type"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await openalexSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "semantic_scholar_fetch",
    "Fetch one Semantic Scholar paper by paper ID, DOI, arXiv ID, or PMID and persist it",
    {
      id: z.string().describe("Semantic Scholar paper ID or supported external identifier"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await semanticScholarFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "semantic_scholar_search",
    "Search Semantic Scholar papers and persist one search-result page",
    {
      query: z.string().describe("Free-text Semantic Scholar query"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await semanticScholarSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "materials_project_fetch",
    "Fetch one Materials Project material by mp-id and persist it as a gbrain entity page",
    {
      id: z.string().describe("Materials Project mp-id, e.g. mp-149"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await materialsProjectFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "materials_project_search",
    "Search Materials Project summaries by formula or mp-id and persist one search-result page",
    {
      query: z.string().describe("Formula or mp-id"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await materialsProjectSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "pdb_fetch",
    "Fetch one RCSB PDB structure by PDB ID and persist it as a gbrain entity page",
    {
      id: z.string().describe("Four-character PDB ID"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await pdbFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "pdb_search",
    "Search RCSB PDB entries and persist one search-result page without auto-persisting every hit",
    {
      query: z.string().describe("Free-text PDB query"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await pdbSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "chembl_fetch",
    "Fetch one ChEMBL molecule by ChEMBL ID and persist it as a compound entity page",
    {
      id: z.string().describe("ChEMBL molecule ID, e.g. CHEMBL25"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await chemblFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "chembl_search",
    "Search ChEMBL molecules and persist one search-result page",
    {
      query: z.string().describe("Free-text molecule query"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await chemblSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "uniprot_fetch",
    "Fetch one UniProtKB protein by accession and persist it as a protein entity page",
    {
      id: z.string().describe("UniProt accession, e.g. P04637"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await uniprotFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "uniprot_search",
    "Search UniProtKB proteins and persist one search-result page",
    {
      query: z.string().describe("Free-text UniProt query"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      page_token: z.string().optional().describe("UniProt cursor token returned from a previous search"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await uniprotSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "clinicaltrials_fetch",
    "Fetch one ClinicalTrials.gov study by NCT ID and persist it as a trial entity page",
    {
      id: z.string().describe("NCT identifier, e.g. NCT04280705"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await clinicalTrialsFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "clinicaltrials_search",
    "Search ClinicalTrials.gov studies and persist one search-result page",
    {
      query: z.string().describe("Free-text trial query"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      page_token: z.string().optional().describe("ClinicalTrials.gov nextPageToken"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await clinicalTrialsSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "orcid_fetch",
    "Fetch one ORCID public record and persist it as a person entity page",
    {
      id: z.string().describe("ORCID iD"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await orcidFetch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "orcid_search",
    "Search ORCID public records and persist one search-result page",
    {
      query: z.string().describe("Free-text ORCID query"),
      page: z.number().optional().describe("1-based result page"),
      page_size: z.number().optional().describe("Results per page, max 200"),
      project: z.string().optional().describe("Optional project slug to link"),
    },
    async (params) => {
      try {
        return formatJson(await orcidSearch(params));
      } catch (error) {
        return formatDatabaseError(error);
      }
    },
  );

  server.tool(
    "research_landscape",
    "Build a deterministic multi-source literature packet and journaled run artifact",
    {
      query: z.string().describe("Landscape query or exact paper title query"),
      exact_title: z.string().optional().describe("Optional exact paper title to resolve deterministically"),
      project: z.string().optional().describe("Optional project slug to link"),
      sources: z.array(z.enum(["pubmed", "arxiv", "openalex", "crossref"])).optional()
        .describe("Optional source allowlist"),
      per_source_limit: z.number().optional().describe("Candidates fetched per source, max 50"),
      retained_limit: z.number().optional().describe("Final retained papers, max 50"),
      start_year: z.number().optional().describe("Optional inclusive lower year bound"),
      end_year: z.number().optional().describe("Optional inclusive upper year bound"),
      retry_count: z.number().optional().describe("Per-source retry count after the first attempt"),
    },
    async (params) => handleResearchLandscape(getConfig(), params),
  );

  server.tool(
    "literature_packet",
    "Alias for research_landscape",
    {
      query: z.string().describe("Landscape query or exact paper title query"),
      exact_title: z.string().optional().describe("Optional exact paper title to resolve deterministically"),
      project: z.string().optional().describe("Optional project slug to link"),
      sources: z.array(z.enum(["pubmed", "arxiv", "openalex", "crossref"])).optional()
        .describe("Optional source allowlist"),
      per_source_limit: z.number().optional().describe("Candidates fetched per source, max 50"),
      retained_limit: z.number().optional().describe("Final retained papers, max 50"),
      start_year: z.number().optional().describe("Optional inclusive lower year bound"),
      end_year: z.number().optional().describe("Optional inclusive upper year bound"),
      retry_count: z.number().optional().describe("Per-source retry count after the first attempt"),
    },
    async (params) => handleResearchLandscape(getConfig(), params),
  );

  // ── 33-39. Audit-and-revise capability tools ───────
  const auditRevisePlanGbrain = createGbrainClient();
  // Lazy audit-revise deps so the MCP runtime and tests can build their own
  // fakes without spawning a live gbrain subprocess at import time.
  let _auditReviseDeps: ReturnType<typeof buildDefaultToolDeps> | null = null;
  const getAuditReviseDeps = () => {
    if (!_auditReviseDeps) _auditReviseDeps = buildDefaultToolDeps();
    return _auditReviseDeps;
  };

  // Artifact resolution, reading, linking, and hosted Descartes critique.

  server.tool(
    "resolve_artifact",
    "Find an audit-revise artifact in the active project; returns a slug or a disambiguation list",
    {
      project: z.string().describe("Active project slug"),
      hint: z
        .string()
        .optional()
        .describe("Optional hint (title fragment, filename, artifact type)"),
    },
    async (params) => {
      try {
        return formatJson(await resolveArtifact(getAuditReviseDeps(), params));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.tool(
    "read_artifact",
    "Read an audit-revise artifact by slug; returns type, title, body, links",
    {
      slug: z.string().describe("gbrain slug of the artifact"),
    },
    async (params) => {
      try {
        return formatJson(await readArtifact(getAuditReviseDeps(), params));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.tool(
    "link_artifact",
    "Create a structural link between two audit-revise artifacts",
    {
      from: z.string().describe("Source slug"),
      to: z.string().describe("Target slug"),
      relation: z
        .enum(["audited_by", "addresses", "revises", "cover_letter_for"])
        .describe("Link relation (must be in the audit-revise allowlist)"),
    },
    async (params) => {
      try {
        return formatJson(await linkArtifact(getAuditReviseDeps(), params));
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.tool(
    "critique_artifact",
    "Run the structured critique service on a paper and persist the response verbatim as a gbrain critique page",
    {
      slug: z.string().describe("Paper slug to critique"),
      style: z
        .enum(["professional", "referee", "internal_red_team"])
        .optional()
        .describe("Style profile (default: professional)"),
    },
    async (params) => {
      try {
        return formatJson(
          await critiqueArtifact(getAuditReviseDeps(), params),
        );
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // Bucket E: draft_revision_plan / approve_revision_plan / cancel_job.

  server.tool(
    "draft_revision_plan",
    "Draft a revision plan from a critique artifact (status: draft)",
    {
      parent_slug: z
        .string()
        .describe("Paper slug the plan is for"),
      critique_slug: z
        .string()
        .describe(
          "Critique slug produced by `critique_artifact` or `resolve_artifact`",
        ),
      scope_hints: z
        .string()
        .optional()
        .describe(
          "Free-text scope hint (e.g. 'text only', 'full', 'translate the german')",
        ),
    },
    async (params) => {
      try {
        const store = getBrainStore();
        const critiquePage = await store.getPage(params.critique_slug);
        if (!critiquePage) {
          throw new Error(
            `draft_revision_plan: no critique page for slug '${params.critique_slug}'`,
          );
        }
        const critiqueFm = (critiquePage.frontmatter ?? {}) as Record<
          string,
          unknown
        >;
        if (critiqueFm.type !== "critique") {
          throw new Error(
            `draft_revision_plan: page '${params.critique_slug}' is type '${String(critiqueFm.type)}', not 'critique'`,
          );
        }
        const project =
          typeof critiqueFm.project === "string" && critiqueFm.project.length > 0
            ? critiqueFm.project
            : params.parent_slug;

        // The critique tool writes the raw Descartes JSON inside a fenced
        // block; parse it back out so the plan can enumerate findings.
        const match = critiquePage.content.match(/```json\s*\n([\s\S]*?)\n```/);
        let payload: unknown = {};
        if (match) {
          try {
            payload = JSON.parse(match[1]);
          } catch {
            payload = {};
          }
        }

        const userHandle = getCurrentUserHandle();
        const draft = draftRevisionPlan({
          paperSlug: params.parent_slug,
          project,
          critiqueSlug: params.critique_slug,
          critiquePayload: payload,
          scopeHints: params.scope_hints,
          userHandle,
        });
        await auditRevisePlanGbrain.putPage(draft.slug, draft.markdown);
        await auditRevisePlanGbrain.linkPages(draft.slug, params.critique_slug, {
          linkType: "addresses",
        });
        return formatJson({
          plan_slug: draft.slug,
          finding_count: draft.findingCount,
          scope: draft.frontmatter.scope,
        });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.tool(
    "approve_revision_plan",
    "Flip a draft revision plan to status: approved",
    {
      plan_slug: z.string().describe("Revision plan slug to approve"),
    },
    async (params) => {
      try {
        const store = getBrainStore();
        const page = await store.getPage(params.plan_slug);
        if (!page) {
          throw new Error(
            `approve_revision_plan: no plan page for slug '${params.plan_slug}'`,
          );
        }
        const fm = (page.frontmatter ?? {}) as Record<string, unknown>;
        if (fm.type !== "revision_plan") {
          throw new Error(
            `approve_revision_plan: page '${params.plan_slug}' is type '${String(fm.type)}', not 'revision_plan'`,
          );
        }
        const matterInput = buildMatterInput(fm, page.content);
        const userHandle = getCurrentUserHandle();
        const result = approveRevisionPlan({
          slug: params.plan_slug,
          markdown: matterInput,
          userHandle,
        });
        await auditRevisePlanGbrain.putPage(result.slug, result.markdown);
        return formatJson({
          plan_slug: result.slug,
          status: result.frontmatter.status,
          approved_at: result.frontmatter.approved_at,
          previous_status: result.previousStatus,
        });
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.tool(
    "cancel_job",
    "Request cooperative cancellation of a running audit-revise job (in-memory flag in v1)",
    {
      handle: z.string().describe("Job handle returned by run_job"),
      reason: z.string().optional().describe("Optional cancel reason"),
    },
    async (params) => {
      try {
        const result = cancelJobHelper(params.handle, params.reason);
        return formatJson(result);
      } catch (error) {
        return formatError(error);
      }
    },
  );

  // Bucket H: run_job / check_job. The tool wrappers here enforce plan
  // §1.1's hard precondition (run_job refused unless the referenced
  // revision_plan is status: approved) before handing off to the
  // pure-helper orchestrator in src/lib/jobs/run-job.ts.
  let _jobDeps: JobDeps | null = null;
  const getJobDeps = () => {
    if (!_jobDeps) _jobDeps = buildDefaultJobDeps();
    return _jobDeps;
  };

  server.tool(
    "run_job",
    "Dispatch an audit-revise job via the OpenHands sandbox",
    {
      kind: z
        .enum([
          "revise_paper",
          "write_cover_letter",
          "rerun_stats_and_regenerate_figure",
          "translate_paper",
        ])
        .describe("Job kind. Must be one of the v1 audit-revise kinds."),
      input_refs: z
        .record(z.string())
        .describe(
          "Map of role → gbrain slug (e.g. { paper, plan, critique }). Must include `plan` when the kind requires an approved revision plan.",
        ),
      expected_artifacts: z
        .array(z.string())
        .optional()
        .describe("Artifact kinds the job is expected to produce."),
      project: z
        .string()
        .optional()
        .describe("Active project slug (optional)."),
    },
    async (params) => {
      try {
        // Plan §1.1 hard precondition: run_job is refused if the
        // referenced revision_plan is not status: approved. Check
        // before handing off to the pure orchestrator so the sandbox
        // is never spun up for an unapproved plan.
        const planSlug =
          typeof params.input_refs.plan === "string"
            ? params.input_refs.plan
            : null;
        if (planSlug) {
          const store = getBrainStore();
          const planPage = await store.getPage(planSlug);
          if (!planPage) {
            throw new Error(
              `run_job: no revision_plan page for slug '${planSlug}'`,
            );
          }
          const planFm = (planPage.frontmatter ?? {}) as Record<
            string,
            unknown
          >;
          if (planFm.type !== "revision_plan") {
            throw new Error(
              `run_job: page '${planSlug}' is type '${String(planFm.type)}', not 'revision_plan'`,
            );
          }
          if (planFm.status !== "approved") {
            throw new Error(
              `run_job: revision_plan '${planSlug}' is status '${String(planFm.status)}', must be 'approved' before run_job`,
            );
          }
        }
        const result = await runJob(getJobDeps(), {
          kind: params.kind,
          project: params.project,
          input_refs: params.input_refs,
          expected_artifacts: params.expected_artifacts,
        });
        return formatJson(result);
      } catch (error) {
        return formatError(error);
      }
    },
  );

  server.tool(
    "check_job",
    "Poll the status of an audit-revise job by handle. Returns status, elapsed_s, final_artifacts (slugs + file SHAs), and error if any.",
    {
      handle: z.string().describe("Job handle returned by run_job"),
    },
    async (params) => {
      try {
        const result = checkJob(getJobDeps(), params.handle);
        return formatJson(result);
      } catch (error) {
        return formatError(error);
      }
    },
  );

  return server;
}

/**
 * Reconstruct the matter-serialised input `approveRevisionPlan` expects
 * from the BrainPage frontmatter + content. BrainStore hands us the
 * parsed frontmatter as a plain object, so we re-serialise before
 * handing it to the pure helper.
 */
function buildMatterInput(
  frontmatter: Record<string, unknown>,
  content: string,
): string {
  return matter.stringify(content, frontmatter);
}

// ── Entrypoint ────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const server = createBrainMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start when run directly
const isDirectRun =
  typeof require !== "undefined" &&
  require.main === module;

if (isDirectRun) {
  startMcpServer().catch((err) => {
    process.stderr.write(`MCP server error: ${err}\n`);
    process.exit(1);
  });
}
