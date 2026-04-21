/**
 * Structured critique HTTP client.
 *
 * Factored out of `src/app/api/structured-critique/route.ts` so both the
 * Next.js proxy route and the MCP `critique_artifact` tool can talk to the
 * hosted Descartes critique service through one code path.
 */

import {
  getStructuredCritiqueConfig,
  getStructuredCritiqueConfigStatus,
  StructuredCritiqueConfigError,
  type StructuredCritiqueConfig,
} from "./structured-critique-config";
import {
  normalizeStructuredCritiqueJobPayload,
  normalizeStructuredCritiqueResultPayload,
  StructuredCritiquePayloadValidationError,
} from "./structured-critique-schema";

export const ALLOWED_STYLE_PROFILES = new Set([
  "professional",
  "referee",
  "internal_red_team",
] as const);

export type StructuredCritiqueStyleProfile =
  | "professional"
  | "referee"
  | "internal_red_team";

export const DEFAULT_STYLE_PROFILE: StructuredCritiqueStyleProfile =
  "professional";

export const SERVICE_UNAVAILABLE_MESSAGE =
  "Analysis service is temporarily unavailable. Try again in a few minutes.";

export const INVALID_UPSTREAM_RESPONSE_MESSAGE =
  "Analysis service returned an invalid response. Try again in a few minutes.";

const READINESS_PROBE_TIMEOUT_MS = 3000;

export class StructuredCritiqueServiceUnavailableError extends Error {
  constructor(message: string = SERVICE_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "StructuredCritiqueServiceUnavailableError";
  }
}

export class StructuredCritiqueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `the critique service did not respond after ${Math.round(timeoutMs / 1000)} seconds. Try again or check the service status.`,
    );
    this.name = "StructuredCritiqueTimeoutError";
  }
}

export class StructuredCritiqueInvalidResponseError extends Error {
  constructor(message: string = INVALID_UPSTREAM_RESPONSE_MESSAGE) {
    super(message);
    this.name = "StructuredCritiqueInvalidResponseError";
  }
}

export type StructuredCritiqueErrorPayload = {
  detail?: unknown;
  error?: unknown;
} | null;

export function buildServiceHeaders(
  config: StructuredCritiqueConfig,
  options: { authorization?: string | null } = {},
): HeadersInit {
  const headers: Record<string, string> = {
    "X-Structured-Critique-Client": config.clientLabel,
  };
  const authorization = options.authorization?.trim();
  if (authorization) {
    headers.Authorization = authorization;
  } else if (config.token) {
    headers.Authorization = `Bearer ${config.token}`;
  }
  return headers;
}

export function isStructuredCritiqueTimeoutError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

export function sanitizeStructuredCritiqueMessage(
  message: string,
  secrets: string[] = [],
): string {
  let sanitized = message
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/([?&](?:token|key|secret|signature)=)[^&\s]+/gi, "$1[redacted]");

  for (const secret of secrets) {
    if (secret) {
      sanitized = sanitized.split(secret).join("[redacted]");
    }
  }

  return sanitized.length > 500 ? `${sanitized.slice(0, 497)}...` : sanitized;
}

export function readErrorDetail(
  payload: StructuredCritiqueErrorPayload,
  response: Response,
  secrets: string[] = [],
): string {
  const detail = payload?.detail;
  const error = payload?.error;
  if (response.status >= 500) {
    const fallback = response.statusText || `HTTP ${response.status}`;
    return sanitizeStructuredCritiqueMessage(fallback, secrets);
  }
  if (response.status === 422) {
    const extractedMessages = [
      ...extractStructuredCritiqueErrorMessages(detail, secrets),
      ...extractStructuredCritiqueErrorMessages(error, secrets),
    ];
    if (extractedMessages.length > 0) {
      return extractedMessages.join("; ");
    }
  }
  if (typeof detail === "string") {
    return sanitizeStructuredCritiqueMessage(detail, secrets);
  }
  if (typeof error === "string") {
    return sanitizeStructuredCritiqueMessage(error, secrets);
  }
  if (error && typeof error === "object" && "user_facing_message" in error) {
    const message = (error as { user_facing_message?: unknown })
      .user_facing_message;
    if (typeof message === "string") {
      return sanitizeStructuredCritiqueMessage(message, secrets);
    }
  }
  if (detail && typeof detail === "object" && "message" in detail) {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === "string") {
      return sanitizeStructuredCritiqueMessage(message, secrets);
    }
  }
  const fallback = response.statusText || `HTTP ${response.status}`;
  return sanitizeStructuredCritiqueMessage(fallback, secrets);
}

function extractStructuredCritiqueErrorMessages(
  value: unknown,
  secrets: string[],
  depth = 0,
): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") {
    const sanitized = sanitizeStructuredCritiqueMessage(value, secrets).trim();
    return sanitized ? [sanitized] : [];
  }
  if (Array.isArray(value)) {
    return dedupeMessages(
      value.flatMap((entry) =>
        extractStructuredCritiqueErrorMessages(entry, secrets, depth + 1)
      ),
    );
  }
  if (typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const directMessage = readStructuredCritiqueDirectMessage(record, secrets);
  const nestedMessages = [
    ...extractStructuredCritiqueErrorMessages(
      record.detail,
      secrets,
      depth + 1,
    ),
    ...extractStructuredCritiqueErrorMessages(
      record.error,
      secrets,
      depth + 1,
    ),
    ...extractStructuredCritiqueErrorMessages(
      record.errors,
      secrets,
      depth + 1,
    ),
  ];

  return dedupeMessages([
    ...(directMessage ? [directMessage] : []),
    ...nestedMessages,
  ]);
}

function readStructuredCritiqueDirectMessage(
  record: Record<string, unknown>,
  secrets: string[],
): string | null {
  const location = formatStructuredCritiqueErrorLocation(record.loc);
  for (const key of [
    "user_facing_message",
    "message",
    "msg",
  ] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const sanitized = sanitizeStructuredCritiqueMessage(value, secrets).trim();
      return location ? `${location}: ${sanitized}` : sanitized;
    }
  }

  const errorValue = record.error;
  if (typeof errorValue === "string" && errorValue.trim().length > 0) {
    const sanitized = sanitizeStructuredCritiqueMessage(
      errorValue,
      secrets,
    ).trim();
    return location ? `${location}: ${sanitized}` : sanitized;
  }

  return null;
}

function formatStructuredCritiqueErrorLocation(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts = value
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return [String(entry)];
      }
      return [];
    })
    .filter((entry) => !["body", "query", "path", "form"].includes(entry));

  if (parts.length === 0) return null;
  return parts.join(".");
}

function dedupeMessages(messages: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const message of messages) {
    const trimmed = message.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
}

export async function fetchStructuredCritique(
  input: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    // Preserve AbortError so the caller can distinguish a real timeout
    // from a network error and surface a plain-language "did not respond
    // after N seconds" message to the chat UI (plan §2.2 critical-gap
    // mitigation).
    if (isStructuredCritiqueTimeoutError(error)) {
      throw error;
    }
    throw new StructuredCritiqueServiceUnavailableError();
  }
}

export async function readStructuredCritiquePayload(
  response: Response,
): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    if (response.ok) throw new StructuredCritiqueInvalidResponseError();
    return null;
  }
}

export type StructuredCritiqueReadinessStatus =
  | "not_configured"
  | "ready"
  | "sign_in_required"
  | "auth_failed"
  | "unavailable"
  | "timeout"
  | "network_error";

export interface StructuredCritiqueReadinessProbe {
  configured: boolean;
  ready: boolean;
  status: StructuredCritiqueReadinessStatus;
  detail: string;
  endpoint?: string;
  httpStatus?: number;
  observedAt: string;
}

export async function probeStructuredCritiqueReadiness(
  timeoutMs = READINESS_PROBE_TIMEOUT_MS,
): Promise<StructuredCritiqueReadinessProbe> {
  const observedAt = new Date().toISOString();
  const configStatus = getStructuredCritiqueConfigStatus();

  if (!configStatus.available) {
    return {
      configured: false,
      ready: false,
      status: "not_configured",
      detail: configStatus.missingKeys.length > 0
        ? `Missing ${configStatus.missingKeys.join(" and ")}.`
        : "Hosted Descartes critique is not configured.",
      observedAt,
    };
  }

  let config: StructuredCritiqueConfig;
  try {
    config = getStructuredCritiqueConfig();
  } catch (error) {
    return {
      configured: false,
      ready: false,
      status: "not_configured",
      detail:
        error instanceof Error
          ? sanitizeStructuredCritiqueMessage(error.message)
          : "Hosted Descartes critique is not configured.",
      observedAt,
    };
  }

  const endpoint = `${config.baseUrl}/ready`;
  const probeTimeoutMs = Math.min(config.timeoutMs, timeoutMs);

  try {
    const response = await fetchStructuredCritique(endpoint, {
      method: "GET",
      headers: buildServiceHeaders(config),
      signal: AbortSignal.timeout(probeTimeoutMs),
    });

    if (response.ok) {
      return {
        configured: true,
        ready: true,
        status: "ready",
        detail: "Hosted Descartes readiness/auth probe succeeded.",
        endpoint,
        httpStatus: response.status,
        observedAt,
      };
    }

    const payload = (await readStructuredCritiquePayload(
      response,
    )) as StructuredCritiqueErrorPayload;
    const detail = readErrorDetail(
      payload,
      response,
      structuredCritiqueSecrets(config),
    );
    const authFailed = response.status === 401 || response.status === 403;
    if (authFailed && config.authMode === "user_session") {
      return {
        configured: true,
        ready: true,
        status: "sign_in_required",
        detail: "ScienceSwarm reasoning is available. Sign in to run a live audit.",
        endpoint,
        httpStatus: response.status,
        observedAt,
      };
    }

    return {
      configured: true,
      ready: false,
      status: authFailed ? "auth_failed" : "unavailable",
      detail: authFailed
        ? "Hosted Descartes rejected the configured credentials."
        : `Hosted Descartes readiness probe failed: ${detail}`,
      endpoint,
      httpStatus: response.status,
      observedAt,
    };
  } catch (error) {
    if (isStructuredCritiqueTimeoutError(error)) {
      return {
        configured: true,
        ready: false,
        status: "timeout",
        detail: `Hosted Descartes readiness probe timed out after ${Math.round(probeTimeoutMs / 1000)} seconds.`,
        endpoint,
        observedAt,
      };
    }
    if (error instanceof StructuredCritiqueServiceUnavailableError) {
      return {
        configured: true,
        ready: false,
        status: "network_error",
        detail: "Hosted Descartes could not be reached from this server.",
        endpoint,
        observedAt,
      };
    }
    return {
      configured: true,
      ready: false,
      status: "unavailable",
      detail:
        error instanceof Error
          ? sanitizeStructuredCritiqueMessage(
              error.message,
              structuredCritiqueSecrets(config),
            )
          : "Hosted Descartes readiness probe failed.",
      endpoint,
      observedAt,
    };
  }
}

export interface SubmitCritiqueInput {
  /** PDF bytes to submit. Either `file` or `text` is required. */
  file?: {
    bytes: Uint8Array;
    filename: string;
    contentType?: string;
  };
  /** Text body alternative. */
  text?: string;
  styleProfile?: StructuredCritiqueStyleProfile;
  fallacyProfile?: string;
  /**
   * Hard wall-clock deadline for the upstream request. Defaults to the
   * `STRUCTURED_CRITIQUE_TIMEOUT_MS` env value honoured by the shared
   * config. The MCP audit-and-revise path raises this to 15 minutes for
   * long-form paper reviews.
   */
  timeoutMs?: number;
  /** Optional AbortSignal to allow external cancel. */
  signal?: AbortSignal;
}

export const STRUCTURED_CRITIQUE_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const STRUCTURED_CRITIQUE_MAX_TEXT_BYTES = 1 * 1024 * 1024;

export interface StructuredCritiqueInputValidationError {
  status: 400 | 413;
  error: string;
}

export function resolveStructuredCritiqueFallacyProfile(
  value?: string | null,
): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

export function validateStructuredCritiqueFileSubmission(
  byteLength: number,
): StructuredCritiqueInputValidationError | null {
  if (byteLength > STRUCTURED_CRITIQUE_MAX_UPLOAD_BYTES) {
    return {
      status: 413,
      error: "PDF upload exceeds the 25 MB structured critique limit",
    };
  }
  if (byteLength === 0) {
    return { status: 400, error: "PDF upload is empty" };
  }
  return null;
}

export function validateStructuredCritiqueTextSubmission(
  text: string,
): StructuredCritiqueInputValidationError | null {
  if (
    new TextEncoder().encode(text).byteLength >
    STRUCTURED_CRITIQUE_MAX_TEXT_BYTES
  ) {
    return {
      status: 413,
      error: "Text submission exceeds the 1 MB structured critique limit",
    };
  }
  return null;
}

export type StructuredCritiqueUpstreamSubmitInput = {
  authorization?: string | null;
  config: StructuredCritiqueConfig;
  fallacyProfile?: string | null;
  file?: File | null;
  signal: AbortSignal;
  styleProfile?: string;
  text?: string | null;
};

export type StructuredCritiqueUpstreamSubmitResponse = {
  payload: unknown | null;
  response: Response;
};

function buildStructuredCritiqueSubmitFormData(input: {
  fallacyProfile?: string | null;
  file?: File | null;
  styleProfile: string;
  text?: string | null;
}): FormData {
  const formData = new FormData();
  if (input.file) {
    formData.append("file", input.file);
  } else if (typeof input.text === "string" && input.text.trim().length > 0) {
    formData.append("text", input.text.trim());
  }
  formData.append("style_profile", input.styleProfile);
  const fallacyProfile = resolveStructuredCritiqueFallacyProfile(
    input.fallacyProfile,
  );
  if (fallacyProfile) {
    formData.append("fallacy_profile", fallacyProfile);
  }
  return formData;
}

async function postStructuredCritiqueFormData(input: {
  authorization?: string | null;
  config: StructuredCritiqueConfig;
  formData: FormData;
  signal: AbortSignal;
}): Promise<StructuredCritiqueUpstreamSubmitResponse> {
  const response = await fetchStructuredCritique(
    `${input.config.baseUrl}/structured-critique`,
    {
      method: "POST",
      headers: buildServiceHeaders(input.config, {
        authorization: input.authorization,
      }),
      body: input.formData,
      signal: input.signal,
    },
  );

  const payload = await readStructuredCritiquePayload(response);
  return { payload, response };
}

export async function submitStructuredCritiqueUpstream(
  input: StructuredCritiqueUpstreamSubmitInput,
): Promise<StructuredCritiqueUpstreamSubmitResponse> {
  return postStructuredCritiqueFormData({
    authorization: input.authorization,
    config: input.config,
    formData: buildStructuredCritiqueSubmitFormData({
      fallacyProfile: input.fallacyProfile,
      file: input.file ?? null,
      styleProfile: input.styleProfile ?? DEFAULT_STYLE_PROFILE,
      text: typeof input.text === "string" ? input.text.trim() : "",
    }),
    signal: input.signal,
  });
}

export interface SubmitCritiqueSuccess {
  ok: true;
  status: number;
  payload: unknown;
}

export interface SubmitCritiqueError {
  ok: false;
  status: number;
  error: string;
}

export type SubmitCritiqueResult =
  | SubmitCritiqueSuccess
  | SubmitCritiqueError;

/**
 * Thin POST wrapper that both the HTTP proxy route and the MCP tool share.
 * Callers pass either file bytes or text; everything else mirrors the
 * original route's behaviour (style_profile gating, config errors → 503,
 * invalid upstream response → 502, service unreachable → 503).
 */
export async function submitStructuredCritique(
  input: SubmitCritiqueInput,
): Promise<SubmitCritiqueResult> {
  let config: StructuredCritiqueConfig;
  try {
    config = getStructuredCritiqueConfig();
  } catch (error) {
    if (error instanceof StructuredCritiqueConfigError) {
      return { ok: false, status: 503, error: error.message };
    }
    throw error;
  }

  const styleProfile = input.styleProfile ?? DEFAULT_STYLE_PROFILE;
  if (!ALLOWED_STYLE_PROFILES.has(styleProfile)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid style_profile. Allowed: ${[...ALLOWED_STYLE_PROFILES].join(", ")}`,
    };
  }

  const hasFile = Boolean(input.file);
  const hasText =
    typeof input.text === "string" && input.text.trim().length > 0;
  if (!hasFile && !hasText) {
    return {
      ok: false,
      status: 400,
      error: "Either file bytes or a text body is required",
    };
  }
  if (hasFile && hasText) {
    return {
      ok: false,
      status: 400,
      error: "Provide either file or text, not both",
    };
  }

  if (hasFile && input.file) {
    const validation = validateStructuredCritiqueFileSubmission(
      input.file.bytes.byteLength,
    );
    if (validation) {
      return { ok: false, ...validation };
    }
  }

  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (hasText) {
    const validation = validateStructuredCritiqueTextSubmission(text);
    if (validation) {
      return { ok: false, ...validation };
    }
  }

  let file: File | null = null;
  if (hasFile && input.file) {
    // Uint8Array -> fresh Uint8Array<ArrayBuffer> so File's strict
    // BlobPart typing is satisfied across Node and DOM typedefs.
    const blobBytes = new Uint8Array(
      input.file.bytes.byteLength,
    );
    blobBytes.set(input.file.bytes);
    file = new File([blobBytes], input.file.filename, {
      type: input.file.contentType ?? "application/pdf",
    });
  }

  const timeoutMs = input.timeoutMs ?? config.timeoutMs;
  const externalSignal = input.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal
    ? anySignal(externalSignal, timeoutSignal)
    : timeoutSignal;

  try {
    const { payload, response } = await submitStructuredCritiqueUpstream({
      config,
      fallacyProfile: input.fallacyProfile,
      file,
      signal,
      styleProfile,
      text,
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: readErrorDetail(
          payload as StructuredCritiqueErrorPayload,
          response,
          structuredCritiqueSecrets(config),
        ),
      };
    }

    const job = normalizeSubmitSuccessPayload(payload);
    return {
      ok: true,
      status: response.status,
      payload: job,
    };
  } catch (error) {
    if (error instanceof StructuredCritiqueServiceUnavailableError) {
      return { ok: false, status: 503, error: error.message };
    }
    if (error instanceof StructuredCritiqueInvalidResponseError) {
      return { ok: false, status: 502, error: error.message };
    }
    if (error instanceof StructuredCritiquePayloadValidationError) {
      return {
        ok: false,
        status: 502,
        error: INVALID_UPSTREAM_RESPONSE_MESSAGE,
      };
    }
    if (isStructuredCritiqueTimeoutError(error)) {
      return {
        ok: false,
        status: 504,
        error: new StructuredCritiqueTimeoutError(timeoutMs).message,
      };
    }
    const message =
      error instanceof Error ? error.message : "Structured critique failed";
    return {
      ok: false,
      status: 500,
      error: sanitizeStructuredCritiqueMessage(
        message,
        structuredCritiqueSecrets(config),
      ),
    };
  }
}

/**
 * Poll for a previously submitted critique by job id. Kept here so the
 * route can stay thin; MCP audit tools use the POST path because they
 * wait for the service response outside the browser polling loop.
 */
export async function fetchStructuredCritiqueByJobId(
  jobId: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<SubmitCritiqueResult> {
  let config: StructuredCritiqueConfig;
  try {
    config = getStructuredCritiqueConfig();
  } catch (error) {
    if (error instanceof StructuredCritiqueConfigError) {
      return { ok: false, status: 503, error: error.message };
    }
    throw error;
  }

  const timeoutMs = options.timeoutMs ?? config.timeoutMs;
  const externalSignal = options.signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = externalSignal
    ? anySignal(externalSignal, timeoutSignal)
    : timeoutSignal;

  try {
    const response = await fetchStructuredCritique(
      `${config.baseUrl}/structured-critique/${encodeURIComponent(jobId)}`,
      {
        method: "GET",
        headers: buildServiceHeaders(config),
        signal,
      },
    );

    const payload = (await readStructuredCritiquePayload(
      response,
    )) as StructuredCritiqueErrorPayload;

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: readErrorDetail(
          payload,
          response,
          structuredCritiqueSecrets(config),
        ),
      };
    }

    const job = normalizeStructuredCritiqueJobPayload(payload);
    return {
      ok: true,
      status: response.status,
      payload: job,
    };
  } catch (error) {
    if (error instanceof StructuredCritiqueServiceUnavailableError) {
      return { ok: false, status: 503, error: error.message };
    }
    if (error instanceof StructuredCritiqueInvalidResponseError) {
      return { ok: false, status: 502, error: error.message };
    }
    if (error instanceof StructuredCritiquePayloadValidationError) {
      return {
        ok: false,
        status: 502,
        error: INVALID_UPSTREAM_RESPONSE_MESSAGE,
      };
    }
    if (isStructuredCritiqueTimeoutError(error)) {
      return {
        ok: false,
        status: 504,
        error: new StructuredCritiqueTimeoutError(timeoutMs).message,
      };
    }
    const message =
      error instanceof Error ? error.message : "Structured critique failed";
    return {
      ok: false,
      status: 500,
      error: sanitizeStructuredCritiqueMessage(
        message,
        structuredCritiqueSecrets(config),
      ),
    };
  }
}

function normalizeSubmitSuccessPayload(payload: unknown): unknown {
  try {
    return normalizeStructuredCritiqueJobPayload(payload);
  } catch (jobError) {
    try {
      return normalizeStructuredCritiqueResultPayload(payload);
    } catch {
      throw jobError;
    }
  }
}

/**
 * Tiny polyfill for `AbortSignal.any()` so we stay off experimental APIs
 * when merging the caller's signal with the timeout. Node 20 has it in
 * recent patch versions but we support the full minor range. Emits abort
 * as soon as any input signal aborts.
 */
function anySignal(...signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as { any?: unknown }).any === "function") {
    return (AbortSignal as unknown as {
      any: (signals: AbortSignal[]) => AbortSignal;
    }).any(signals);
  }
  const controller = new AbortController();
  const cleanup: Array<() => void> = [];
  const onAbort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason);
    }
    for (const fn of cleanup) fn();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      onAbort(signal);
      break;
    }
    const handler = () => onAbort(signal);
    signal.addEventListener("abort", handler);
    cleanup.push(() => signal.removeEventListener("abort", handler));
  }
  return controller.signal;
}

function structuredCritiqueSecrets(
  config: StructuredCritiqueConfig,
): string[] {
  return config.token ? [config.token] : [];
}
