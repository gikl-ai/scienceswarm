/**
 * POST /api/setup
 *
 * Writes user-supplied config values to `.env` via the atomic
 * env-writer. Returns `restartRequired: true` on success because
 * Next.js only loads `.env` into `process.env` at boot — our
 * write is visible on disk immediately but the running server will
 * keep using the stale snapshot until it restarts.
 *
 * Contract notes
 *   * We never echo secret values back. Validation errors include
 *     field names only (so the UI knows which field to highlight) and
 *     never the raw string that failed.
 *   * An `undefined` body field means "don't touch this env var". An
 *     explicit empty string for `scienceswarmDir` means "remove the
 *     override, revert to the default" — that's the one field where
 *     empty has a deliberate meaning. Other fields treat empty as
 *     "leave alone" to prevent accidental key deletion.
 *   * Unknown body fields are rejected with 400. We want the client
 *     and server to agree on the exact wire shape so typos don't get
 *     silently dropped.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { isLocalRequest } from "@/lib/local-guard";
import { isBrainPresetId } from "@/brain/presets/types";
import { OLLAMA_RECOMMENDED_MODEL } from "@/lib/ollama-constants";
import {
  configureOpenClawModel,
  normalizeOpenClawModel,
} from "@/lib/openclaw/model-config";
import { resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import {
  validateOpenAiKey,
  validateScienceSwarmDir,
  type FieldStatus,
} from "@/lib/setup/config-status";
import {
  mergeEnvValues,
  parseEnvFile,
  serializeEnvDocument,
  writeEnvFileAtomic,
  type EnvDocument,
} from "@/lib/setup/env-writer";

/**
 * The client-facing payload. Every field is optional; omitting a field
 * means "don't touch its env var". Only `scienceswarmDir` treats the
 * empty string as a sentinel (remove the override).
 */
interface SetupRequestBody {
  openaiApiKey?: string;
  scienceswarmDir?: string;
  telegramBotToken?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  githubId?: string;
  githubSecret?: string;
  brainPreset?: string;
  // PR B stage B1 additions: brain profile, LLM provider toggle,
  // Ollama model selection, and agent backend pick. These are all
  // plain-string fields that round-trip into .env verbatim, with the
  // exception of `llmProvider` and `agentBackend` which must match a
  // closed enum (validation happens in `validateProvidedFields`).
  brainProfileName?: string;
  brainProfileField?: string;
  brainProfileInstitution?: string;
  llmProvider?: string;
  ollamaModel?: string;
  agentBackend?: string;
}

type SetupFieldName = keyof SetupRequestBody;

/**
 * Map from request-body field name to the `.env` key we write.
 * Also the source of truth for which body fields are accepted — any
 * property in the incoming body not present here is rejected.
 */
const FIELD_TO_ENV_KEY: Readonly<Record<SetupFieldName, string>> = {
  openaiApiKey: "OPENAI_API_KEY",
  scienceswarmDir: "SCIENCESWARM_DIR",
  telegramBotToken: "TELEGRAM_BOT_TOKEN",
  googleClientId: "GOOGLE_CLIENT_ID",
  googleClientSecret: "GOOGLE_CLIENT_SECRET",
  githubId: "GITHUB_ID",
  githubSecret: "GITHUB_SECRET",
  brainPreset: "BRAIN_PRESET",
  brainProfileName: "BRAIN_PROFILE_NAME",
  brainProfileField: "BRAIN_PROFILE_FIELD",
  brainProfileInstitution: "BRAIN_PROFILE_INSTITUTION",
  llmProvider: "LLM_PROVIDER",
  ollamaModel: "OLLAMA_MODEL",
  agentBackend: "AGENT_BACKEND",
};

const ACCEPTED_FIELDS = new Set<string>(Object.keys(FIELD_TO_ENV_KEY));

// Closed enums for the two toggle-shaped fields. `LLM_PROVIDER` drives
// which model provider the app routes inference through; `AGENT_BACKEND`
// selects the required code-exec backend. Anything outside these sets
// must be rejected at the API boundary rather than silently written to
// .env and discovered at runtime.
const VALID_LLM_PROVIDERS = new Set<string>(["openai", "local"]);
const VALID_AGENT_BACKENDS = new Set<string>([
  "openclaw",
  "nanoclaw",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the request body against the declared shape. Returns a typed
 * body on success, or a 400 `Response` describing the first
 * structural problem it finds.
 *
 * We reject unknown fields up front so the contract is tight: a typo
 * like `openAIApiKey` surfaces at the server boundary rather than
 * being silently dropped.
 */
function parseBody(
  raw: unknown,
): { ok: true; body: SetupRequestBody } | { ok: false; response: Response } {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      response: Response.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      ),
    };
  }

  const unknown: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!ACCEPTED_FIELDS.has(key)) {
      unknown.push(key);
    }
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      response: Response.json(
        {
          error: `Unknown field(s) in request body: ${unknown.join(", ")}`,
          unknownFields: unknown,
        },
        { status: 400 },
      ),
    };
  }

  const body: SetupRequestBody = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        response: Response.json(
          { error: `Field '${key}' must be a string`, field: key },
          { status: 400 },
        ),
      };
    }
    body[key as SetupFieldName] = value;
  }
  return { ok: true, body };
}

/**
 * Validate just the fields that (a) were provided and (b) have
 * dedicated validators. `openaiApiKey` and `scienceswarmDir` are the
 * only two we classify structurally today; the other tokens are
 * opaque strings that we accept as-is.
 *
 * Returns a map from field name to `FieldStatus` for every field
 * whose validation failed (placeholder or invalid). An empty map
 * means "everything the user sent was acceptable".
 *
 * Notes on what counts as "provided": an `undefined` value isn't in
 * the body map at all (filtered out in `parseBody`). An empty string
 * is provided — but empty strings only have semantic meaning for
 * `scienceswarmDir` ("remove the override"), so we skip validation of
 * empty strings for both validated fields to avoid false positives.
 */
async function validateProvidedFields(
  body: SetupRequestBody,
): Promise<Partial<Record<SetupFieldName, FieldStatus>>> {
  const errors: Partial<Record<SetupFieldName, FieldStatus>> = {};

  if (body.openaiApiKey !== undefined && body.openaiApiKey !== "") {
    const status = validateOpenAiKey(body.openaiApiKey);
    if (status.state === "placeholder" || status.state === "invalid") {
      errors.openaiApiKey = status;
    }
  }

  if (body.scienceswarmDir !== undefined && body.scienceswarmDir !== "") {
    const status = await validateScienceSwarmDir(body.scienceswarmDir);
    if (status.state === "placeholder" || status.state === "invalid") {
      errors.scienceswarmDir = status;
    }
  }

  // Enum-guarded fields. We only flag a failure on non-empty input so
  // the "omit → no-op" and "empty-string → no-op" semantics from the
  // other fields stay consistent. A wrong value fails with a helpful
  // reason listing the accepted tokens.
  if (
    body.brainPreset !== undefined
    && body.brainPreset !== ""
    && !isBrainPresetId(body.brainPreset)
  ) {
    errors.brainPreset = {
      state: "invalid",
      reason: "brainPreset must be one of: generic_scientist, scientific_research",
    };
  }

  if (
    body.llmProvider !== undefined
    && body.llmProvider !== ""
    && !VALID_LLM_PROVIDERS.has(body.llmProvider)
  ) {
    errors.llmProvider = {
      state: "invalid",
      reason: `llmProvider must be one of: ${Array.from(
        VALID_LLM_PROVIDERS,
      ).join(", ")}`,
    };
  }

  if (
    body.agentBackend !== undefined
    && body.agentBackend !== ""
    && !VALID_AGENT_BACKENDS.has(body.agentBackend)
  ) {
    errors.agentBackend = {
      state: "invalid",
      reason: `agentBackend must be one of: ${Array.from(
        VALID_AGENT_BACKENDS,
      ).join(", ")}`,
    };
  }

  return errors;
}

/**
 * Load the current `.env` (if present) and return a parsed
 * document. A missing file yields a fresh empty document — we still
 * want to be able to write the first save.
 */
async function loadEnvDocument(repoRoot: string): Promise<EnvDocument> {
  const filePath = path.join(repoRoot, ".env");
  let contents: string;
  try {
    contents = await fs.readFile(filePath, { encoding: "utf8" });
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return { lines: [], newline: "\n", trailingNewline: true };
    }
    throw err;
  }
  return parseEnvFile(contents);
}

/**
 * Fields where an explicit empty string is a deliberate "remove this
 * key from .env" signal rather than an ambiguous blank input. These
 * are the non-secret, user-visible profile fields plus the
 * `scienceswarmDir` override — clearing them from the UI must actually
 * wipe the stored value rather than silently preserving the old one.
 *
 * Everything else (API keys, OAuth secrets, tokens) keeps the
 * "empty means no-op" protection so the redacted-prefill flow on the
 * /setup page can't accidentally wipe a saved secret when the user
 * submits a form with the redacted input left blank.
 */
const EMPTY_MEANS_REMOVE: ReadonlySet<SetupFieldName> = new Set<SetupFieldName>(
  [
    "scienceswarmDir",
    "brainPreset",
    "brainProfileName",
    "brainProfileField",
    "brainProfileInstitution",
  ],
);

type EnvEntry = Extract<EnvDocument["lines"][number], { type: "entry" }>;

/**
 * Build the `mergeEnvValues` updates map. Fields listed in
 * `EMPTY_MEANS_REMOVE` treat the empty string as an explicit "drop
 * this line from .env" signal; non-empty directory values are
 * normalized to an absolute path before writing so `.env` never stores
 * a relative path or raw `~/...` token. Every other empty string is
 * skipped ("leave alone") to avoid accidental secret deletion.
 */
function buildUpdates(
  body: SetupRequestBody,
): Record<string, string | null> {
  const updates: Record<string, string | null> = {};
  for (const [field, envKey] of Object.entries(FIELD_TO_ENV_KEY) as [
    SetupFieldName,
    string,
  ][]) {
    const value = body[field];
    if (value === undefined) {
      continue;
    }
    if (value === "" && EMPTY_MEANS_REMOVE.has(field)) {
      // Explicit clear: propagate as `null` so mergeEnvValues drops the
      // line from the document. This is how the UI deletes a
      // previously-saved brain-profile entry or reverts the
      // scienceswarmDir override.
      updates[envKey] = null;
      continue;
    }
    if (value === "") {
      // Empty strings on other fields (API keys, OAuth secrets) are
      // ambiguous — treat as no-op to protect against accidental
      // secret wipes from the redacted-prefill flow.
      continue;
    }
    updates[envKey] =
      field === "scienceswarmDir"
        ? (resolveConfiguredPath(value) ?? value)
        : value;
  }
  return updates;
}

function envMapFromDocument(doc: EnvDocument): Map<string, string> {
  return new Map(
    doc.lines
      .filter((line): line is EnvEntry => line.type === "entry")
      .map((entry) => [entry.key, entry.value]),
  );
}

function shouldSyncOpenClawForSetupSave(body: SetupRequestBody): boolean {
  return (
    body.llmProvider !== undefined ||
    body.ollamaModel !== undefined ||
    body.agentBackend !== undefined
  );
}

async function syncOpenClawLocalModelAfterSetup(
  body: SetupRequestBody,
  nextDoc: EnvDocument,
): Promise<{ ok: true; model: string } | { ok: false } | null> {
  if (!shouldSyncOpenClawForSetupSave(body)) {
    return null;
  }

  const values = envMapFromDocument(nextDoc);
  const llmProvider = values.get("LLM_PROVIDER")?.trim().toLowerCase();
  const agentBackend = values.get("AGENT_BACKEND")?.trim().toLowerCase();
  if (llmProvider !== "local" || agentBackend !== "openclaw") {
    return null;
  }

  const model = normalizeOpenClawModel(
    values.get("OLLAMA_MODEL")?.trim() || OLLAMA_RECOMMENDED_MODEL,
    "local",
  );
  try {
    const ok = await configureOpenClawModel(model, "local", {
      timeoutMs: 10_000,
    });
    return ok ? { ok: true, model } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON in request body" },
      { status: 400 },
    );
  }

  const parsed = parseBody(raw);
  if (!parsed.ok) {
    return parsed.response;
  }

  const fieldErrors = await validateProvidedFields(parsed.body);
  if (Object.keys(fieldErrors).length > 0) {
    return Response.json(
      {
        error: "One or more fields failed validation",
        fields: fieldErrors,
      },
      { status: 400 },
    );
  }

  const repoRoot = process.cwd();
  const filePath = path.join(repoRoot, ".env");
  let openClawModelSync: Awaited<
    ReturnType<typeof syncOpenClawLocalModelAfterSetup>
  > = null;

  try {
    const doc = await loadEnvDocument(repoRoot);
    const updates = buildUpdates(parsed.body);
    const nextDoc = mergeEnvValues(doc, updates);
    const serialized = serializeEnvDocument(nextDoc);
    await writeEnvFileAtomic(filePath, serialized);
    openClawModelSync = await syncOpenClawLocalModelAfterSetup(
      parsed.body,
      nextDoc,
    );
  } catch (err) {
    // Log the specific error server-side for operator debugging, but
    // never echo raw exception text back to the client — Node I/O
    // errors can embed absolute filesystem paths that reveal the
    // user's home directory layout. The client only needs to know
    // that the save failed so it can retry or fall back to manual
    // editing.
    console.error(
      "api/setup: failed to write .env",
      err instanceof Error ? err.name : typeof err,
    );
    return Response.json(
      { error: "Failed to write .env" },
      { status: 500 },
    );
  }

  // Confirm the new file parses and read the resulting status for
  // potential client-side reconciliation. We do *not* block the
  // restart-required signal on this — the write succeeded, the
  // running server just needs to bounce to pick up the new values.
  //
  // We intentionally discard the status payload here: returning it
  // would let the client skip calling GET /api/setup/status, but it
  // would also risk echoing secret raw values in the save response.
  // Keep save and status cleanly separated.
  return Response.json({
    ok: true,
    restartRequired: true,
    redirect: "/dashboard/settings",
    openClawModelSync,
  });
}
