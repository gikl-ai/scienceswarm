import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import matter from "gray-matter";

import {
  handleBrainRead,
  handleBrainSearch,
} from "@/brain/mcp-server";
import { loadBrainConfig } from "@/brain/config";
import {
  createBrainCaptureHandler,
  type BrainCaptureParams,
} from "@/brain/handle-brain-capture";
import type { GbrainClient, GbrainPutResult } from "@/brain/gbrain-client";
import { createInProcessGbrainClient } from "@/brain/in-process-gbrain-client";
import { resolveScienceSwarmRuntimeAppOrigin } from "@/lib/gbrain/source-of-truth";
import type { BrainConfig } from "@/brain/types";
import { registerRuntimeMcpTools } from "@/lib/runtime-hosts/mcp/server";
import type {
  RuntimeApprovalState,
  RuntimeProjectPolicy,
} from "@/lib/runtime-hosts/contracts";

type RuntimeScopedSearchParams = {
  projectId: string;
  query: string;
  mode?: string;
  limit?: number;
  detail?: string;
};

type RuntimeScopedReadParams = {
  projectId: string;
  path: string;
};

type McpTextResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type RuntimeAppProjectPageSummary = {
  slug?: unknown;
  path?: unknown;
  title?: unknown;
  type?: unknown;
  frontmatter?: unknown;
};

type RuntimeAppBrainPage = {
  path?: unknown;
  slug?: unknown;
  title?: unknown;
  type?: unknown;
  content?: unknown;
  compiled_truth?: unknown;
  frontmatter?: unknown;
  error?: unknown;
};

type RuntimeAppSearchResult = {
  path: string;
  title: string;
  snippet: string;
  relevance: number;
  type: string;
};

const RUNTIME_APP_FETCH_TIMEOUT_MS = 10_000;
const RUNTIME_MCP_IDLE_EXIT_MS = 20_000;
const PROJECT_SEARCH_SCAN_LIMIT = 50;

function rejectJavaScriptFrontmatter(): Record<string, never> {
  throw new Error("JavaScript frontmatter is not supported for gbrain pages");
}

const SAFE_GRAY_MATTER_OPTIONS = {
  engines: {
    js: rejectJavaScriptFrontmatter,
    javascript: rejectJavaScriptFrontmatter,
  },
};

function runtimeApprovalStateFromEnv(value: string | undefined): RuntimeApprovalState {
  if (
    value === "not-required"
    || value === "required"
    || value === "approved"
    || value === "rejected"
  ) {
    return value;
  }
  return "approved";
}

function runtimeProjectPolicyFromEnv(value: string | undefined): RuntimeProjectPolicy {
  if (value === "local-only" || value === "cloud-ok" || value === "execution-ok") {
    return value;
  }
  return "cloud-ok";
}

function runtimeInputFileRefsFromEnv(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function errorResponse(message: string): McpTextResponse {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

function runtimeAppOrigin(): string | null {
  return resolveScienceSwarmRuntimeAppOrigin(process.env);
}

async function fetchRuntimeAppJson<T>(
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    RUNTIME_APP_FETCH_TIMEOUT_MS,
  );
  timer.unref?.();
  try {
    const response = await fetch(`${origin}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text.trim().length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text };
      }
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error?: unknown }).error)
          : `ScienceSwarm app request failed with ${response.status}`;
      throw new Error(message);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

function route(pathname: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value.length > 0) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function extractResponseText(response: McpTextResponse): string {
  return response.content.find((item) => item.type === "text")?.text ?? "";
}

function frontmatterProjectMatches(
  data: Record<string, unknown>,
  projectId: string,
): boolean {
  const project = data.project;
  if (typeof project === "string" && project === projectId) return true;
  const projectIdField = data.project_id ?? data.projectId;
  if (typeof projectIdField === "string" && projectIdField === projectId) {
    return true;
  }
  const projects = data.projects;
  return Array.isArray(projects)
    && projects.some((value) => typeof value === "string" && value === projectId);
}

function pathLooksProjectScoped(pagePath: string, projectId: string): boolean {
  const normalized = pagePath.replace(/\\/g, "/").replace(/\.md$/i, "");
  return (
    normalized === projectId
    || normalized === `projects/${projectId}`
    || normalized.startsWith(`projects/${projectId}/`)
    || normalized.includes(`/imports/${projectId}/`)
    || normalized.includes(`/imports/${projectId}-`)
  );
}

function responseBelongsToProject(
  responseText: string,
  pagePath: string,
  projectId: string,
): boolean {
  if (pathLooksProjectScoped(pagePath, projectId)) return true;
  try {
    const parsed = matter(responseText, SAFE_GRAY_MATTER_OPTIONS);
    return frontmatterProjectMatches(parsed.data as Record<string, unknown>, projectId);
  } catch {
    return false;
  }
}

function normalizeProjectSummary(
  page: RuntimeAppProjectPageSummary,
): {
  path: string;
  title: string;
  type: string;
  frontmatter: Record<string, unknown>;
} | null {
  const path =
    typeof page.slug === "string"
      ? page.slug
      : typeof page.path === "string"
        ? page.path
        : "";
  if (!path) return null;
  const frontmatter =
    page.frontmatter && typeof page.frontmatter === "object" && !Array.isArray(page.frontmatter)
      ? (page.frontmatter as Record<string, unknown>)
      : {};
  return {
    path,
    title: typeof page.title === "string" && page.title ? page.title : path,
    type: typeof page.type === "string" && page.type ? page.type : "note",
    frontmatter,
  };
}

function normalizeRuntimeAppPage(
  page: RuntimeAppBrainPage,
  requestedPath: string,
): {
  path: string;
  title: string;
  type: string;
  content: string;
  frontmatter: Record<string, unknown>;
} {
  const path =
    typeof page.path === "string"
      ? page.path
      : typeof page.slug === "string"
        ? page.slug
        : requestedPath;
  const frontmatter =
    page.frontmatter && typeof page.frontmatter === "object" && !Array.isArray(page.frontmatter)
      ? (page.frontmatter as Record<string, unknown>)
      : {};
  return {
    path,
    title: typeof page.title === "string" && page.title ? page.title : path,
    type: typeof page.type === "string" && page.type ? page.type : "note",
    content:
      typeof page.content === "string"
        ? page.content
        : typeof page.compiled_truth === "string"
          ? page.compiled_truth
          : "",
    frontmatter,
  };
}

function formatRuntimeAppPageForMcpRead(
  page: ReturnType<typeof normalizeRuntimeAppPage>,
): string {
  const frontmatter = {
    ...page.frontmatter,
    type: page.frontmatter.type ?? page.type,
    title: page.frontmatter.title ?? page.title,
  };
  return matter.stringify(page.content, frontmatter).trim();
}

async function readRuntimeAppBrainPage(
  origin: string,
  pagePath: string,
): Promise<ReturnType<typeof normalizeRuntimeAppPage>> {
  const page = await fetchRuntimeAppJson<RuntimeAppBrainPage>(
    origin,
    route("/api/brain/read", { path: pagePath }),
  );
  return normalizeRuntimeAppPage(page, pagePath);
}

function tokenizeQuery(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^\w\s-]/g, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 2),
    ),
  );
}

function scoreProjectPage(
  page: ReturnType<typeof normalizeRuntimeAppPage>,
  query: string,
): number {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return 0.5;
  const haystack = `${page.path}\n${page.title}\n${page.type}\n${page.content}`.toLowerCase();
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  if (matches === 0) return 0;
  return Math.min(1, 0.25 + matches / tokens.length * 0.75);
}

function snippetForProjectPage(
  page: ReturnType<typeof normalizeRuntimeAppPage>,
  query: string,
): string {
  const normalized = page.content.replace(/\s+/g, " ").trim();
  if (!normalized) return page.path;
  const lower = normalized.toLowerCase();
  const token = tokenizeQuery(query).find((candidate) => lower.includes(candidate));
  const start = token ? Math.max(0, lower.indexOf(token) - 120) : 0;
  return normalized.slice(start, start + 420).trim();
}

async function searchRuntimeAppProjectBrain(
  origin: string,
  params: RuntimeScopedSearchParams,
): Promise<McpTextResponse> {
  const summaries = await fetchRuntimeAppJson<RuntimeAppProjectPageSummary[]>(
    origin,
    route("/api/brain/list", { project: params.projectId }),
  );
  const normalizedSummaries = Array.isArray(summaries)
    ? summaries.map(normalizeProjectSummary).filter((page): page is NonNullable<typeof page> => Boolean(page))
    : [];
  const requestedLimit = Math.max(1, Math.min(params.limit ?? 10, PROJECT_SEARCH_SCAN_LIMIT));
  const scanLimit = Math.max(requestedLimit, PROJECT_SEARCH_SCAN_LIMIT);

  if (params.mode === "list" && !params.query.trim()) {
    const results = normalizedSummaries.slice(0, requestedLimit).map((page) => ({
      path: page.path,
      title: page.title,
      snippet: page.path,
      relevance: 0.5,
      type: page.type,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  }

  const results: RuntimeAppSearchResult[] = [];
  for (const summary of normalizedSummaries.slice(0, scanLimit)) {
    let page: ReturnType<typeof normalizeRuntimeAppPage>;
    try {
      page = await readRuntimeAppBrainPage(origin, summary.path);
    } catch {
      page = {
        ...summary,
        content: `${summary.title}\n${summary.path}`,
      };
    }
    if (!responseBelongsToProject(
      formatRuntimeAppPageForMcpRead(page),
      page.path,
      params.projectId,
    )) {
      continue;
    }
    const relevance = scoreProjectPage(page, params.query);
    if (relevance <= 0) continue;
    results.push({
      path: page.path,
      title: page.title,
      snippet: snippetForProjectPage(page, params.query),
      relevance,
      type: page.type,
    });
  }

  results.sort((left, right) => {
    if (right.relevance !== left.relevance) return right.relevance - left.relevance;
    return left.title.localeCompare(right.title);
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(results.slice(0, requestedLimit), null, 2),
      },
    ],
  };
}

async function readProjectScopedBrainPage(
  config: BrainConfig,
  params: RuntimeScopedReadParams,
): Promise<McpTextResponse> {
  const origin = runtimeAppOrigin();
  if (origin) {
    const page = await readRuntimeAppBrainPage(origin, params.path);
    const responseText = formatRuntimeAppPageForMcpRead(page);
    if (responseBelongsToProject(responseText, page.path, params.projectId)) {
      return { content: [{ type: "text", text: responseText }] };
    }
    return errorResponse(
      `gbrain page is outside the active runtime project (${params.projectId}).`,
    );
  }

  const response = await handleBrainRead(config, { path: params.path });
  if (response.isError) return response;
  if (
    responseBelongsToProject(
      extractResponseText(response),
      params.path,
      params.projectId,
    )
  ) {
    return response;
  }
  return errorResponse(
    `gbrain page is outside the active runtime project (${params.projectId}).`,
  );
}

async function searchProjectScopedBrain(
  config: BrainConfig,
  params: RuntimeScopedSearchParams,
): Promise<McpTextResponse> {
  const origin = runtimeAppOrigin();
  if (origin) {
    return searchRuntimeAppProjectBrain(origin, params);
  }

  const response = await handleBrainSearch(config, {
    ...params,
    limit: Math.max(params.limit ?? 10, PROJECT_SEARCH_SCAN_LIMIT),
  });
  if (response.isError) return response;

  let results: unknown;
  try {
    results = JSON.parse(extractResponseText(response));
  } catch {
    return response;
  }
  if (!Array.isArray(results)) return response;

  const filtered = [];
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const pagePath = (result as { path?: unknown }).path;
    if (typeof pagePath !== "string" || pagePath.trim().length === 0) continue;
    const read = await handleBrainRead(config, { path: pagePath });
    if (
      !read.isError
      && responseBelongsToProject(
        extractResponseText(read),
        pagePath,
        params.projectId,
      )
    ) {
      filtered.push(result);
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(filtered.slice(0, params.limit ?? 10), null, 2),
      },
    ],
  };
}

function createRuntimeGbrainClient(): GbrainClient {
  const origin = runtimeAppOrigin();
  if (!origin) return createInProcessGbrainClient();

  return {
    async putPage(slug: string, content: string): Promise<GbrainPutResult> {
      const result = await fetchRuntimeAppJson<Record<string, unknown>>(
        origin,
        "/api/brain/runtime-page",
        {
          method: "POST",
          body: JSON.stringify({ slug, content }),
        },
      );
      return {
        stdout: JSON.stringify(result),
        stderr: typeof result.stderr === "string" ? result.stderr : "",
      };
    },
    async linkPages(): Promise<GbrainPutResult> {
      return {
        stdout: JSON.stringify({
          status: "skipped",
          reason: "runtime HTTP bridge does not create links",
        }),
        stderr: "",
      };
    },
  };
}

function createRuntimeMcpServer(): McpServer {
  const server = new McpServer({
    name: "scienceswarm-runtime",
    version: "0.1.0",
  });
  let config: BrainConfig | null = null;
  const idleExit = createIdleExitController();

  function getConfig(): BrainConfig {
    config ??= loadBrainConfig();
    if (!config) {
      throw new Error(
        "Brain not configured. Initialize ~/.scienceswarm/brain or set BRAIN_ROOT.",
      );
    }
    return config;
  }

  const brainCapture = createBrainCaptureHandler({
    client: createRuntimeGbrainClient(),
  });

  registerRuntimeMcpTools(server, {
    defaultAuth: {
      token: process.env.SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN,
      projectId: process.env.SCIENCESWARM_RUNTIME_MCP_PROJECT_ID,
      runtimeSessionId: process.env.SCIENCESWARM_RUNTIME_MCP_SESSION_ID,
      hostId: process.env.SCIENCESWARM_RUNTIME_MCP_HOST_ID,
      projectPolicy: runtimeProjectPolicyFromEnv(
        process.env.SCIENCESWARM_RUNTIME_MCP_PROJECT_POLICY,
      ),
      approved: process.env.SCIENCESWARM_RUNTIME_MCP_APPROVED !== "false",
    },
    trustedToken: process.env.SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN,
    runtimeProvenanceDefaults: {
      promptHash:
        process.env.SCIENCESWARM_RUNTIME_MCP_PROMPT_HASH ?? "runtime-mcp",
      inputFileRefs: runtimeInputFileRefsFromEnv(
        process.env.SCIENCESWARM_RUNTIME_MCP_INPUT_FILE_REFS,
      ),
      approvalState: runtimeApprovalStateFromEnv(
        process.env.SCIENCESWARM_RUNTIME_MCP_APPROVAL_STATE,
      ),
    },
    brainSearch: (params) => idleExit.run(() =>
      searchProjectScopedBrain(getConfig(), params)
    ),
    brainRead: (params) => idleExit.run(() =>
      readProjectScopedBrainPage(getConfig(), params)
    ),
    brainCapture: (params) => idleExit.run(() =>
      brainCapture(params as BrainCaptureParams)
    ),
  });

  return server;
}

function createIdleExitController(): {
  run<T>(operation: () => Promise<T>): Promise<T>;
} {
  let active = 0;
  let timer: NodeJS.Timeout | null = null;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    if (active > 0) {
      timer = null;
      return;
    }
    timer = setTimeout(() => process.exit(0), RUNTIME_MCP_IDLE_EXIT_MS);
  };

  schedule();

  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      active += 1;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        return await operation();
      } finally {
        active = Math.max(0, active - 1);
        schedule();
      }
    },
  };
}

async function startRuntimeMcpServer(): Promise<void> {
  installStdinLifecycleExit();
  const server = createRuntimeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function installStdinLifecycleExit(): void {
  let exiting = false;
  const exitSoon = () => {
    if (exiting) return;
    exiting = true;
    const timer = setTimeout(() => process.exit(0), 0);
    timer.unref?.();
  };
  process.stdin.once("end", exitSoon);
  process.stdin.once("close", exitSoon);
}

void startRuntimeMcpServer().catch((error) => {
  process.stderr.write(`Runtime MCP server error: ${error}\n`);
  process.exit(1);
});
