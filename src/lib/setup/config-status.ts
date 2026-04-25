// Config validity checker for the `/setup` page.
//
// The /setup UI needs to know, on every render, whether the current
// `.env` on disk contains real values or still-templated values
// that would break the app downstream. This module answers that
// question with a single `getConfigStatus(repoRoot)` call.
//
// Why we re-read `.env` from disk every call:
//
//   Next.js loads `.env` into `process.env` exactly once at
//   server startup. After the setup page writes a new value via
//   `writeEnvFileAtomic`, `process.env` is still the stale snapshot
//   from boot time. If we checked `process.env`, the UI would keep
//   telling the user "still missing" no matter how many times they
//   saved a correct value. Reading the file directly on each status
//   fetch is the only way to see the user's latest edits without a
//   full server restart. Callers that need to validate a deployed
//   runtime can opt into process-env fallback for readiness only; the
//   setup UI pre-fill still comes exclusively from `.env` on disk.
//
// All I/O is async. This module never throws on missing files —
// absence is a valid state the UI displays.
//
// Shape:
//   - `readEnvFile(repoRoot)` — load + parse `.env` if present.
//   - `validateOpenAiKey(value)` — classify a raw key string.
//   - `validateScienceSwarmDir(value)` — classify a raw dir string,
//     including async filesystem checks.
//   - `getConfigStatus(repoRoot)` — one call that combines the above
//     into the structured status object the UI consumes.

import { constants as fsConstants, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isGbrainRootReady } from "@/lib/brain/readiness";
import { expandHomeDir, resolveConfiguredPath } from "@/lib/scienceswarm-paths";

import { parseEnvFile, type EnvInvalidLine } from "./env-writer";
import { isPlaceholderValue } from "./placeholder-detection";
import {
  REDACTED_SECRET_SENTINEL,
  SECRET_ENV_KEYS,
  SETUP_ENV_KEYS,
} from "./secret-constants";

// Re-export so server-side callers can keep importing both the types
// and the constants from a single module. The constants themselves
// live in `./secret-constants` so the client-side /setup page can
// pull them in without also pulling in `node:fs` via this file.
export { REDACTED_SECRET_SENTINEL, SECRET_ENV_KEYS, SETUP_ENV_KEYS };

const SETUP_ENV_KEY_SET = new Set<string>(SETUP_ENV_KEYS);
const RUNTIME_CONFIG_KEYS = [
  "OPENAI_API_KEY",
  "SCIENCESWARM_DIR",
  "AGENT_BACKEND",
  "LLM_PROVIDER",
  "OLLAMA_MODEL",
] as const;

export interface ConfigStatusOptions {
  /**
   * Allow non-empty process-env values for runtime config keys to
   * satisfy `ready` when the on-disk `.env` is incomplete. This is for
   * deployed/UAT runtimes where env vars are supplied by the process
   * manager rather than written into `.env`. It never changes
   * `rawValues`, so the setup endpoint still cannot echo runtime
   * secrets.
   */
  includeRuntimeEnv?: boolean;
}

export type FieldStatus =
  | { state: "ok" }
  | { state: "missing" }
  | { state: "placeholder"; reason: string }
  | { state: "invalid"; reason: string };

/**
 * Brain profile summary pulled from `.env`. All three are plain
 * strings; missing keys surface as empty strings so the UI can render
 * them uniformly without null-guards. None of these values are
 * secrets — they're just the researcher's own name / field /
 * institution, which the /setup UI displays back as pre-fill.
 */
export interface BrainProfileSummary {
  name: string;
  field: string;
  institution: string;
}

/**
 * Thin OpenClaw summary for the /setup page. Mirrors
 * `OpenClawSetupSummary` from `@/lib/openclaw-status` but is
 * duplicated here so consumers of `ConfigStatus` don't need an extra
 * import to pin the shape.
 */
export interface OpenClawStatusSummary {
  installed: boolean;
  configured: boolean;
  running: boolean;
}

/**
 * Ollama probe projection: the /setup page only needs to know whether
 * the binary exists, whether it's serving, whether the recommended
 * model is pulled, plus the install/start commands to show on the
 * "install Ollama" button. The rest of `OllamaInstallStatus` is kept
 * internal to the helper.
 */
export interface OllamaStatusSummary {
  installed: boolean;
  running: boolean;
  hasRecommendedModel: boolean;
  models?: string[];
  installCommand?: string;
  startCommand?: string;
}

export interface ConfigStatus {
  openaiApiKey: FieldStatus;
  scienceswarmDir: FieldStatus;
  envFileExists: boolean;
  envFileParseError: string | null;
  /**
   * True iff the user has a supported agent backend configured, a
   * usable LLM provider configured, and `SCIENCESWARM_DIR` is `ok`.
   * A valid backend means either `AGENT_BACKEND=openclaw` or
   * `AGENT_BACKEND=nanoclaw`. A valid LLM means either:
   *   - `OPENAI_API_KEY` is present and well-formed, OR
   *   - `LLM_PROVIDER=local` is saved, delegating chat to the local
   *     Ollama daemon configured separately in the UI.
   */
  ready: boolean;
  /**
   * Current setup-related key/value map, for UI pre-fill.
   *
   * Only keys the Phase 1 `/setup` form actually renders are included.
   * Secrets are replaced with `REDACTED_SECRET_SENTINEL`
   * (`"<configured>"`) instead of being echoed in the clear.
   */
  rawValues: Record<string, string>;
  /**
   * Names of keys from `.env` whose raw value was hidden behind
   * the `REDACTED_SECRET_SENTINEL` placeholder before being put in
   * `rawValues`. The UI uses this list to decide which fields to show
   * a "currently set — leave blank to keep" hint on. A key only
   * appears in this list if it (a) is in `SECRET_ENV_KEYS` and (b) had
   * a non-empty value on disk.
   */
  redactedKeys: string[];
  /**
   * PR B stage B1 additions — optional environmental summaries so the
   * /setup page can render the brain-profile, OpenClaw, and Ollama
   * sections from a single status fetch. Probes that fail at runtime
   * come back as `undefined` rather than failing the whole call —
   * `ready` still gates only on backend/provider/data-dir validity.
   */
  brainProfile?: BrainProfileSummary;
  openclawStatus?: OpenClawStatusSummary;
  ollamaStatus?: OllamaStatusSummary;
  /**
   * Non-secret summary of the durable setup data already available on disk.
   * This is intentionally separate from `ready`: a runtime provider can be
   * temporarily incomplete while the user profile and brain are already
   * initialized, and that state should land in chat/settings instead of
   * forcing the user through first-run onboarding again.
   */
  persistedSetup?: PersistedSetupSummary;
}

export interface PersistedSetupSummary {
  hasUserHandle: boolean;
  hasEmail: boolean;
  hasTelegramBotToken: boolean;
  brainRootReady: boolean;
  complete: boolean;
}


/**
 * Read `<repoRoot>/.env` and report whether it parsed.
 *
 *   - If the file does not exist, return `{ contents: null, parseError: null }`.
 *   - If reading the file blows up for any other reason (permissions,
 *     symlink loop, etc.), surface that as a `parseError` string — we
 *     deliberately do *not* throw, because the caller wants to render
 *     a helpful UI rather than 500.
 *   - If the file exists and parses, return the raw contents.
 *   - If the file contains a syntactically invalid line, return the
 *     raw contents plus a line-numbered warning so the UI can tell the
 *     user exactly what will be preserved-as-is on save.
 */
export async function readEnvFile(
  repoRoot: string,
): Promise<{ contents: string | null; parseError: string | null }> {
  const filePath = path.join(repoRoot, ".env");
  let contents: string;
  try {
    contents = await fs.readFile(filePath, { encoding: "utf8" });
  } catch (err: unknown) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      return { contents: null, parseError: null };
    }
    // Log the full detail (including path / OS error text) to the
    // server console so a developer can diagnose, but return a
    // sanitized category through the API response body. The raw
    // message can include the full `.env` path plus the
    // filesystem error string, both of which would leak through the
    // unauthenticated `/api/setup/status` endpoint.
    console.error("[setup] failed to read .env", {
      filePath,
      error: err,
    });
    return {
      contents: null,
      parseError: "Failed to read .env.",
    };
  }
  try {
    const doc = parseEnvFile(contents);
    const invalidLines = doc.lines.filter(
      (line): line is EnvInvalidLine => line.type === "invalid",
    );
    if (invalidLines.length > 0) {
      const lineNumbers = invalidLines.map((line) => line.lineNumber).join(", ");
      const lineLabel = invalidLines.length === 1 ? "Line" : "Lines";
      const pronoun = invalidLines.length === 1 ? "It" : "They";
      return {
        contents,
        parseError: `${lineLabel} ${lineNumbers} of .env could not be parsed. ${pronoun} will be preserved as-is on save.`,
      };
    }
  } catch (err: unknown) {
    console.error("[setup] failed to parse .env", {
      filePath,
      error: err,
    });
    return {
      contents,
      parseError: "Failed to parse .env.",
    };
  }
  return { contents, parseError: null };
}

/**
 * Classify an OpenAI API key string.
 *
 *   - `undefined` / empty string → `missing`.
 *   - Matches a known placeholder (e.g. `sk-proj-REPLACE-ME-…`) →
 *     `placeholder` with the matcher's reason string.
 *   - Doesn't start with `sk-` → `invalid`. OpenAI keys are
 *     `sk-…`-prefixed in every currently shipped format (classic,
 *     project, admin). Rejecting other prefixes catches typos like
 *     pasting the org ID or the GitHub token by mistake.
 *   - Otherwise → `ok`.
 *
 * We trim before comparing so trailing whitespace from a paste doesn't
 * poison the validation. We don't attempt to validate the checksum or
 * length — OpenAI has changed the length at least once in the past and
 * a conservative prefix check has fewer false negatives.
 */
export function validateOpenAiKey(value: string | undefined): FieldStatus {
  if (value === undefined) {
    return { state: "missing" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { state: "missing" };
  }
  const placeholder = isPlaceholderValue(trimmed);
  if (placeholder.isPlaceholder) {
    return {
      state: "placeholder",
      reason: placeholder.reason ?? "is a placeholder value",
    };
  }
  if (!trimmed.startsWith("sk-")) {
    return {
      state: "invalid",
      reason: "OpenAI API keys start with 'sk-'",
    };
  }
  return { state: "ok" };
}

/**
 * Classify an `SCIENCESWARM_DIR` value.
 *
 *   - `undefined` / empty → `ok`. An unset `SCIENCESWARM_DIR` means the
 *     app will fall back to `~/.scienceswarm`, which is a valid default.
 *     The setup UI treats "not set" and "set to the default" as the
 *     same user intent.
 *   - Placeholder (via `isPlaceholderValue`) → `placeholder`.
 *   - Tilde is expanded before any filesystem operation.
 *   - Path exists and is a directory → `ok`.
 *   - Path exists but is not a directory → `invalid` with a reason
 *     that names what it is (file, symlink, socket). The user
 *     probably pasted a file path by accident.
 *   - Path does not exist, but the parent directory exists and is
 *     writable → `ok`. We haven't created it yet but the app can
 *     mkdir it on demand, which is the installer's job, not setup's.
 *   - Path does not exist and parent isn't writable / doesn't exist →
 *     `invalid` with a reason that points at the parent. Users see
 *     "the parent /foo doesn't exist" and can fix it, rather than a
 *     cryptic EACCES at runtime.
 */
export async function validateScienceSwarmDir(
  value: string | undefined,
): Promise<FieldStatus> {
  if (value === undefined) {
    return { state: "ok" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { state: "ok" };
  }
  const placeholder = isPlaceholderValue(trimmed);
  if (placeholder.isPlaceholder) {
    return {
      state: "placeholder",
      reason: placeholder.reason ?? "is a placeholder value",
    };
  }
  const expanded = expandHomeDir(trimmed);
  const absolute = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(expanded);

  // Reasons returned from here are surfaced verbatim through the
  // unauthenticated `GET /api/setup/status` endpoint. We therefore
  // emit generic, actionable strings that never include the raw path
  // being validated, the raw exception message, or the parent path.
  // Developers can consult the server console (via `console.error`)
  // for the full detail needed to diagnose a bad value.

  // Use `lstat` first so we can see the link node itself — a dangling
  // symlink would raise ENOENT from `fs.stat`, which would otherwise
  // mis-classify the path as "doesn't exist yet, check the parent" and
  // potentially report the value as `ok`. If the entry itself exists
  // as a link, we fall back to `fs.stat` to follow it only when the
  // target resolves.
  let linkStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    linkStat = await fs.lstat(absolute);
  } catch (err: unknown) {
    if (!isNodeErrnoException(err) || err.code !== "ENOENT") {
      console.error("[setup] cannot stat data directory", {
        absolute,
        error: err,
      });
      return {
        state: "invalid",
        reason: "Path cannot be read",
      };
    }
    // Path really doesn't exist. Fall through to the parent check.
  }

  if (linkStat !== null) {
    if (linkStat.isSymbolicLink()) {
      // Follow the link. Any error here — dangling target, permission,
      // loop — means this isn't a usable directory regardless of the
      // underlying code, so we classify it as invalid and surface a
      // clear reason. We don't distinguish ENOENT at this point
      // because a dangling symlink is not "the path doesn't exist";
      // the symlink does exist, it just points nowhere.
      try {
        const targetStat = await fs.stat(absolute);
        if (targetStat.isDirectory()) {
          return { state: "ok" };
        }
        return {
          state: "invalid",
          reason: "Path is a symlink to a non-directory",
        };
      } catch (err: unknown) {
        console.error(
          "[setup] cannot resolve symlink target for data directory",
          { absolute, error: err },
        );
        return {
          state: "invalid",
          reason: "Path is a symlink whose target cannot be resolved",
        };
      }
    }
    if (linkStat.isDirectory()) {
      return { state: "ok" };
    }
    return {
      state: "invalid",
      reason: "Path exists but is not a directory",
    };
  }

  // Path does not exist. We don't require the user to have created it
  // already; we only require that mkdir would succeed. That means the
  // immediate parent must exist and be writable.
  const parent = path.dirname(absolute);
  let parentStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    parentStat = await fs.stat(parent);
  } catch (err: unknown) {
    if (isNodeErrnoException(err) && err.code === "ENOENT") {
      return {
        state: "invalid",
        reason: "Parent directory does not exist",
      };
    }
    console.error("[setup] cannot stat parent directory", {
      parent,
      error: err,
    });
    return {
      state: "invalid",
      reason: "Parent directory cannot be read",
    };
  }
  if (!parentStat.isDirectory()) {
    return {
      state: "invalid",
      reason: "Parent is not a directory",
    };
  }
  try {
    // `fs.access` with W_OK is the portable way to check "could I
    // mkdir here?". It isn't perfect (TOCTOU race with the eventual
    // write) but it catches the most common wrong-path failure modes.
    await fs.access(parent, fsConstants.W_OK);
  } catch (err: unknown) {
    console.error("[setup] parent directory is not writable", {
      parent,
      error: err,
    });
    return {
      state: "invalid",
      reason: "Parent directory is not writable",
    };
  }
  return { state: "ok" };
}

/**
 * Compose the full config status. Reads `.env` once, extracts
 * every entry, and runs the per-field validators.
 *
 * Secret handling: this function is the backbone of the
 * unauthenticated `GET /api/setup/status` endpoint. Raw secret values
 * must never flow into the response, and unrelated env vars should not
 * either. We therefore validate against the true on-disk value, but in
 * the `rawValues` map we expose only setup-form keys, with every
 * non-empty secret replaced by `REDACTED_SECRET_SENTINEL`.
 */
export async function getConfigStatus(
  repoRoot: string,
  options: ConfigStatusOptions = {},
): Promise<ConfigStatus> {
  const { contents, parseError } = await readEnvFile(repoRoot);
  const envFileExists = contents !== null;

  // Two maps: the true values (kept locally, used only for field
  // validation) and the redacted values we actually return.
  // `redactedKeys` lists every key whose true value was hidden, so the
  // UI can render "set — leave blank to keep the current value"
  // without needing to see the value itself.
  const trueValues: Record<string, string> = {};
  const rawValues: Record<string, string> = {};
  const redactedKeys: string[] = [];
  if (contents !== null) {
    // `parseEnvFile` is total; it won't throw on any input we've seen
    // in the wild. If `readEnvFile` already surfaced a `parseError`,
    // we still attempt validation on whatever we could extract so the
    // UI can be maximally helpful.
    try {
      const doc = parseEnvFile(contents);
      for (const line of doc.lines) {
        if (line.type === "entry") {
          trueValues[line.key] = line.value;
          if (!SETUP_ENV_KEY_SET.has(line.key)) {
            continue;
          }
          if (SECRET_ENV_KEYS.has(line.key)) {
            if (line.value.length > 0) {
              // Present but redacted: the UI gets the sentinel, not
              // the real value, and sees the key in `redactedKeys` so
              // it can show the "leave blank to keep" helper.
              rawValues[line.key] = REDACTED_SECRET_SENTINEL;
              redactedKeys.push(line.key);
            } else {
              // An empty secret value is visible as-is: "not set yet"
              // is a valid UI state and isn't sensitive.
              rawValues[line.key] = "";
            }
          } else {
            rawValues[line.key] = line.value;
          }
        }
      }
    } catch {
      // Defensive: swallow here because `parseError` already records
      // the user-visible explanation.
    }
  }

  // Validation runs on true values — redacting first would cause every
  // configured secret to be reported as `ok` regardless of whether the
  // real value is a placeholder or malformed. Runtime overrides only
  // affect readiness, never the raw setup UI values returned below.
  const diskReadiness = await computeReadiness(trueValues);
  const runtimeValues = options.includeRuntimeEnv
    ? withRuntimeOverrides(trueValues)
    : trueValues;
  const runtimeReadiness =
    runtimeValues === trueValues
      ? diskReadiness
      : await computeReadiness(runtimeValues);
  const ready = diskReadiness.ready || runtimeReadiness.ready;

  // Brain profile is read straight from .env; missing keys become
  // empty strings so the UI can always render the fields uniformly.
  // These values are plain non-secret metadata (researcher name,
  // field, institution) so we echo them without redaction.
  const brainProfile: BrainProfileSummary = {
    name: trueValues["BRAIN_PROFILE_NAME"] ?? "",
    field: trueValues["BRAIN_PROFILE_FIELD"] ?? "",
    institution: trueValues["BRAIN_PROFILE_INSTITUTION"] ?? "",
  };
  const persistedSetup = computePersistedSetupSummary(trueValues);

  return {
    openaiApiKey: diskReadiness.openaiApiKey,
    scienceswarmDir: diskReadiness.scienceswarmDir,
    envFileExists,
    envFileParseError: parseError,
    ready,
    rawValues,
    redactedKeys,
    brainProfile,
    persistedSetup,
  };
}

// -----------------------------------------------------------------
// Internals
// -----------------------------------------------------------------

function isNodeErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

async function computeReadiness(values: Record<string, string>): Promise<{
  openaiApiKey: FieldStatus;
  scienceswarmDir: FieldStatus;
  ready: boolean;
}> {
  const openaiApiKey = validateOpenAiKey(values["OPENAI_API_KEY"]);
  const scienceswarmDir = await validateScienceSwarmDir(
    values["SCIENCESWARM_DIR"],
  );
  // A user who chose Local (Ollama + Gemma) as their LLM provider
  // never sets OPENAI_API_KEY. Treat `LLM_PROVIDER=local` as a valid
  // provider path, but only when setup also has a real agent backend
  // selected. The setup flow is agent-first; a direct no-backend path
  // is never considered complete.
  const llmProviderRaw = (values["LLM_PROVIDER"] ?? "")
    .trim()
    .toLowerCase();
  const agentBackendRaw = (values["AGENT_BACKEND"] ?? "")
    .trim()
    .toLowerCase();
  const hasConfiguredAgentBackend =
    agentBackendRaw === "openclaw" || agentBackendRaw === "nanoclaw";
  const hasConfiguredLocalModel =
    (values["OLLAMA_MODEL"] ?? "").trim().length > 0;
  const hasUsableLlm =
    llmProviderRaw === "local"
      ? hasConfiguredLocalModel
      : openaiApiKey.state === "ok";

  return {
    openaiApiKey,
    scienceswarmDir,
    ready:
      hasConfiguredAgentBackend
      && hasUsableLlm
      && scienceswarmDir.state === "ok",
  };
}

function computePersistedSetupSummary(
  values: Record<string, string>,
): PersistedSetupSummary {
  const hasUserHandle = hasUsablePlainValue(values["SCIENCESWARM_USER_HANDLE"]);
  const hasEmail = hasUsablePlainValue(values["GIT_USER_EMAIL"]);
  const hasTelegramBotToken =
    (values["TELEGRAM_BOT_TOKEN"] ?? "").trim().length > 0;
  const brainRootReady = isGbrainRootReady(resolveBrainRoot(values));

  return {
    hasUserHandle,
    hasEmail,
    hasTelegramBotToken,
    brainRootReady,
    complete: hasUserHandle && brainRootReady,
  };
}

function hasUsablePlainValue(value: string | undefined): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return false;
  return !isPlaceholderValue(trimmed).isPlaceholder;
}

function resolveBrainRoot(values: Record<string, string>): string {
  const dataRoot =
    resolveConfiguredPath(values["SCIENCESWARM_DIR"])
    ?? path.join(os.homedir(), ".scienceswarm");
  return (
    resolveConfiguredPath(values["BRAIN_ROOT"])
    ?? path.join(dataRoot, "brain")
  );
}

function withRuntimeOverrides(
  diskValues: Record<string, string>,
): Record<string, string> {
  let runtimeValues: Record<string, string> | null = null;
  for (const key of RUNTIME_CONFIG_KEYS) {
    const value = process.env[key];
    if (value === undefined || value.trim().length === 0) {
      continue;
    }
    runtimeValues ??= { ...diskValues };
    runtimeValues[key] = value;
  }
  return runtimeValues ?? diskValues;
}
