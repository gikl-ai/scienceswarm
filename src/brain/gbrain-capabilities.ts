import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readScienceSwarmGbrainPackageState,
  resolveScienceSwarmRepoRoot,
  scienceSwarmGbrainBin,
  type ScienceSwarmGbrainPackageState,
} from "@/lib/gbrain/source-of-truth";
import { getBrainStore } from "./store";

const execFileAsync = promisify(execFile);

export const GBRAIN_STRUCTURAL_MIN_VERSION = "0.21.0";
export const GBRAIN_STRUCTURAL_COMMIT =
  "f718c595b3a382b2a9a6a1f6553448ad047b5e94";
export const GBRAIN_STRUCTURAL_SCHEMA_VERSION = 28;
export const GBRAIN_STRUCTURAL_CHUNKER_VERSION = "4";

const REQUIRED_CLI_OPERATIONS = [
  "code-def",
  "code-refs",
  "code-callers",
  "code-callees",
  "reindex-code",
] as const;

const REQUIRED_SCHEMA_FIELDS = [
  { table: "sources", column: "chunker_version" },
  { table: "content_chunks", column: "symbol_name" },
  { table: "content_chunks", column: "symbol_type" },
  { table: "content_chunks", column: "symbol_name_qualified" },
  { table: "content_chunks", column: "parent_symbol_path" },
  { table: "content_chunks", column: "search_vector" },
  { table: "code_edges_chunk", column: "from_chunk_id" },
  { table: "code_edges_chunk", column: "to_chunk_id" },
  { table: "code_edges_symbol", column: "to_symbol_qualified" },
] as const;

const DEFAULT_PROBE_CACHE_TTL_MS = 30_000;

type ProbeStatus = "ready" | "degraded" | "unknown";

export interface GbrainDoctorProbe {
  ok: boolean;
  schemaVersion: number | null;
  rawStatus: ProbeStatus;
  message?: string;
}

export interface GbrainSchemaSnapshot {
  schemaVersion: number | null;
  fields: Array<{ table: string; column: string }>;
  sourceChunkerVersions: Array<string | null>;
}

export interface GbrainCapabilities {
  structuralNavigationAvailable: boolean;
  package: {
    requiredVersion: string;
    requiredCommit: string;
    expectedVersion: string | null;
    expectedResolved: string | null;
    installedVersion: string | null;
    installedName: string | null;
    binPath: string;
    binExists: boolean;
    inSync: boolean;
    ready: boolean;
  };
  doctor: GbrainDoctorProbe;
  schema: {
    requiredVersion: number;
    observedVersion: number | null;
    requiredFieldsPresent: boolean;
    missingFields: string[];
    rawStatus: ProbeStatus;
  };
  operations: {
    required: string[];
    available: string[];
    missing: string[];
    rawStatus: ProbeStatus;
  };
  chunker: {
    requiredVersion: string;
    sourceVersions: Array<string | null>;
    supported: boolean;
    rawStatus: ProbeStatus;
  };
  reindex: {
    status:
      | "not-required"
      | "required"
      | "unknown"
      | "unavailable";
    reason: string;
  };
  blockers: string[];
}

export interface ProbeGbrainCapabilitiesOptions {
  repoRoot?: string;
  packageState?: ScienceSwarmGbrainPackageState;
  doctor?: GbrainDoctorProbe;
  schema?: GbrainSchemaSnapshot | null;
  helpText?: string | null;
}

interface RuntimeSchemaEngine {
  getConfig(key: string): Promise<string | null>;
  executeRaw<T = Record<string, unknown>>(sql: string): Promise<T[]>;
}

let defaultProbeCache: {
  expiresAt: number;
  value: GbrainCapabilities;
} | null = null;

function compareVersions(left: string | null, right: string): number {
  if (!left) return -1;
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < len; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function packageReady(state: ScienceSwarmGbrainPackageState): boolean {
  return Boolean(
    state.inSync
      && state.expectedVersion
      && compareVersions(state.expectedVersion, GBRAIN_STRUCTURAL_MIN_VERSION) >= 0
      && state.installedVersion
      && compareVersions(state.installedVersion, GBRAIN_STRUCTURAL_MIN_VERSION) >= 0
      && state.expectedResolved?.includes(GBRAIN_STRUCTURAL_COMMIT),
  );
}

function parseDoctorSchemaVersion(output: string): GbrainDoctorProbe {
  try {
    const parsed = JSON.parse(output) as {
      status?: unknown;
      checks?: Array<{ name?: unknown; status?: unknown; message?: unknown }>;
    };
    const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
    const schemaCheck = checks.find((check) => check.name === "schema_version");
    const message =
      typeof schemaCheck?.message === "string" ? schemaCheck.message : undefined;
    const match = message?.match(/Version\s+(\d+)/i);
    const schemaVersion = match ? Number.parseInt(match[1], 10) : null;
    const ok =
      schemaCheck?.status === "ok"
      && schemaVersion !== null
      && schemaVersion >= GBRAIN_STRUCTURAL_SCHEMA_VERSION;
    return {
      ok,
      schemaVersion,
      rawStatus: schemaVersion === null ? "unknown" : ok ? "ready" : "degraded",
      message,
    };
  } catch (error) {
    return {
      ok: false,
      schemaVersion: null,
      rawStatus: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function doctorProbeFromSchema(schema: GbrainSchemaSnapshot): GbrainDoctorProbe {
  const ok =
    schema.schemaVersion !== null
    && schema.schemaVersion >= GBRAIN_STRUCTURAL_SCHEMA_VERSION;
  return {
    ok,
    schemaVersion: schema.schemaVersion,
    rawStatus:
      schema.schemaVersion === null ? "unknown" : ok ? "ready" : "degraded",
    message:
      schema.schemaVersion === null
        ? "Schema version unavailable from active gbrain engine."
        : `Version ${schema.schemaVersion} read from active gbrain engine; doctor subprocess skipped to avoid PGLite lock contention.`,
  };
}

async function runDoctorProbe(binPath: string): Promise<GbrainDoctorProbe> {
  try {
    const { stdout } = await execFileAsync(binPath, ["doctor", "--json"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return parseDoctorSchemaVersion(stdout);
  } catch (error) {
    return {
      ok: false,
      schemaVersion: null,
      rawStatus: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readHelpText(binPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, ["--help"], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return `${stdout}\n${stderr}`;
  } catch {
    return null;
  }
}

function operationsFromHelp(helpText: string | null): {
  available: string[];
  missing: string[];
  rawStatus: ProbeStatus;
} {
  if (!helpText) {
    return {
      available: [],
      missing: [...REQUIRED_CLI_OPERATIONS],
      rawStatus: "unknown",
    };
  }
  const available = REQUIRED_CLI_OPERATIONS.filter((operation) =>
    new RegExp(`\\b${operation}\\b`).test(helpText),
  );
  const missing = REQUIRED_CLI_OPERATIONS.filter(
    (operation) => !available.includes(operation),
  );
  return {
    available,
    missing,
    rawStatus: missing.length === 0 ? "ready" : "degraded",
  };
}

function buildSchemaState(schema: GbrainSchemaSnapshot | null | undefined) {
  if (!schema) {
    return {
      observedVersion: null,
      requiredFieldsPresent: false,
      missingFields: REQUIRED_SCHEMA_FIELDS.map(
        (field) => `${field.table}.${field.column}`,
      ),
      rawStatus: "unknown" as ProbeStatus,
    };
  }

  const present = new Set(
    schema.fields.map((field) => `${field.table}.${field.column}`),
  );
  const missingFields = REQUIRED_SCHEMA_FIELDS
    .map((field) => `${field.table}.${field.column}`)
    .filter((field) => !present.has(field));
  const versionReady =
    schema.schemaVersion !== null
    && schema.schemaVersion >= GBRAIN_STRUCTURAL_SCHEMA_VERSION;

  return {
    observedVersion: schema.schemaVersion,
    requiredFieldsPresent: versionReady && missingFields.length === 0,
    missingFields,
    rawStatus: versionReady && missingFields.length === 0
      ? "ready" as ProbeStatus
      : "degraded" as ProbeStatus,
  };
}

function buildChunkerState(schema: GbrainSchemaSnapshot | null | undefined) {
  if (!schema) {
    return {
      sourceVersions: [],
      supported: false,
      rawStatus: "unknown" as ProbeStatus,
    };
  }
  const sourceVersions = schema.sourceChunkerVersions;
  const supported =
    sourceVersions.length === 0
    || sourceVersions.every((version) =>
      version === null || version === GBRAIN_STRUCTURAL_CHUNKER_VERSION
    );
  return {
    sourceVersions,
    supported,
    rawStatus: supported ? "ready" as ProbeStatus : "degraded" as ProbeStatus,
  };
}

function buildReindexState(
  schema: GbrainSchemaSnapshot | null | undefined,
  operationsMissing: string[],
) {
  if (operationsMissing.includes("reindex-code")) {
    return {
      status: "unavailable" as const,
      reason: "Installed gbrain does not expose reindex-code.",
    };
  }
  if (!schema) {
    return {
      status: "unknown" as const,
      reason: "Local gbrain schema metadata was unavailable.",
    };
  }
  const staleSources = schema.sourceChunkerVersions.filter(
    (version) => version !== null && version !== GBRAIN_STRUCTURAL_CHUNKER_VERSION,
  );
  if (staleSources.length === 0) {
    return {
      status: "not-required" as const,
      reason: "No sources report an older chunker version.",
    };
  }
  return {
    status: "required" as const,
    reason:
      "At least one source reports an older chunker version; run reindex-code only through an explicit maintenance path.",
  };
}

export async function readCurrentGbrainSchemaSnapshot(): Promise<GbrainSchemaSnapshot | null> {
  try {
    const store = getBrainStore();
    const engine = (store as unknown as { engine?: RuntimeSchemaEngine }).engine;
    if (!engine || typeof engine.executeRaw !== "function") return null;

    const [version, columns, sources] = await Promise.all([
      engine.getConfig("version").catch(() => null),
      engine.executeRaw<{ table_name: string; column_name: string }>(
        [
          "SELECT table_name, column_name",
          "FROM information_schema.columns",
          "WHERE table_schema = 'public'",
          "AND table_name IN ('sources', 'content_chunks', 'code_edges_chunk', 'code_edges_symbol')",
        ].join(" "),
      ),
      engine.executeRaw<{ chunker_version: string | null }>(
        "SELECT DISTINCT chunker_version FROM sources ORDER BY chunker_version",
      ),
    ]);
    return {
      schemaVersion:
        typeof version === "string" && version.trim()
          ? Number.parseInt(version, 10)
          : null,
      fields: columns.map((row) => ({
        table: row.table_name,
        column: row.column_name,
      })),
      sourceChunkerVersions: sources.map((row) => row.chunker_version ?? null),
    };
  } catch {
    return null;
  }
}

export async function probeGbrainCapabilities(
  options: ProbeGbrainCapabilitiesOptions = {},
): Promise<GbrainCapabilities> {
  const useDefaultCache = Object.keys(options).length === 0;
  const now = Date.now();
  if (
    useDefaultCache
    && defaultProbeCache
    && defaultProbeCache.expiresAt > now
  ) {
    return defaultProbeCache.value;
  }

  const repoRoot = options.repoRoot ?? resolveScienceSwarmRepoRoot();
  const packageState =
    options.packageState ?? readScienceSwarmGbrainPackageState(repoRoot);
  const binPath = packageState.binPath || scienceSwarmGbrainBin(repoRoot);
  const packageIsReady = packageReady(packageState);
  const schema = options.schema === undefined
    ? await readCurrentGbrainSchemaSnapshot()
    : options.schema;
  const doctor = options.doctor
    ?? (schema ? doctorProbeFromSchema(schema) : packageState.binExists ? await runDoctorProbe(binPath) : {
      ok: false,
      schemaVersion: null,
      rawStatus: "unknown" as ProbeStatus,
      message: "gbrain binary is unavailable.",
    });
  const helpText = options.helpText === undefined
    ? packageState.binExists
      ? await readHelpText(binPath)
      : null
    : options.helpText;

  const schemaState = buildSchemaState(schema);
  const operations = operationsFromHelp(helpText);
  const chunker = buildChunkerState(schema);
  const reindex = buildReindexState(schema, operations.missing);

  const blockers: string[] = [];
  if (!packageIsReady) blockers.push("gbrain package is not pinned, installed, and in sync with v0.21.0.");
  if (!doctor.ok) blockers.push("gbrain doctor has not confirmed the required schema.");
  if (!schemaState.requiredFieldsPresent) blockers.push("local schema is missing required structural fields.");
  if (operations.missing.length > 0) blockers.push("installed gbrain is missing required structural CLI operations.");
  if (!chunker.supported) blockers.push("one or more sources need explicit code reindexing.");

  const capabilities = {
    structuralNavigationAvailable: blockers.length === 0,
    package: {
      requiredVersion: GBRAIN_STRUCTURAL_MIN_VERSION,
      requiredCommit: GBRAIN_STRUCTURAL_COMMIT,
      expectedVersion: packageState.expectedVersion,
      expectedResolved: packageState.expectedResolved,
      installedVersion: packageState.installedVersion,
      installedName: packageState.installedName,
      binPath,
      binExists: packageState.binExists,
      inSync: packageState.inSync,
      ready: packageIsReady,
    },
    doctor,
    schema: {
      requiredVersion: GBRAIN_STRUCTURAL_SCHEMA_VERSION,
      ...schemaState,
    },
    operations: {
      required: [...REQUIRED_CLI_OPERATIONS],
      ...operations,
    },
    chunker: {
      requiredVersion: GBRAIN_STRUCTURAL_CHUNKER_VERSION,
      ...chunker,
    },
    reindex,
    blockers,
  };

  if (useDefaultCache) {
    defaultProbeCache = {
      expiresAt: now + DEFAULT_PROBE_CACHE_TTL_MS,
      value: capabilities,
    };
  }

  return capabilities;
}
