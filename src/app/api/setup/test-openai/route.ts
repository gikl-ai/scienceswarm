/**
 * POST /api/setup/test-openai
 *
 * Probes whether an OpenAI API key is valid by hitting the cheapest
 * authenticated endpoint OpenAI offers (`/v1/models`). Returns a
 * structured `{ ok, reason? }` payload that the `/setup` UI uses to
 * show a green checkmark or a field-specific hint.
 *
 * Design notes
 *   * We accept the key in the POST body rather than a URL query
 *     string. Query strings land in server access logs, browser
 *     history, and proxy logs; the body does not. OpenAI keys are
 *     secrets and we treat them that way end-to-end.
 *   * This endpoint returns HTTP 200 for every outcome except a
 *     malformed request. The `ok` field carries the result. That
 *     shape keeps the UI logic straightforward ("read the JSON, show
 *     the reason") without forcing the UI to interpret HTTP status
 *     codes.
 *   * The upstream call is bounded by a 10-second AbortController so
 *     a hanging OpenAI request can never stall the setup page. Any
 *     abort or network error collapses to `reason: "network"` — the
 *     user's actionable response is the same ("check your
 *     connection, try again") regardless of the specific socket
 *     failure.
 */
import { isLocalRequest } from "@/lib/local-guard";
import { evaluateStrictLocalDestination } from "@/lib/runtime/strict-local-policy";

export const runtime = "nodejs";

interface TestOpenAiRequestBody {
  key?: unknown;
}

type TestOpenAiReason =
  | "missing"
  | "strict-local"
  | "unauthorized"
  | "rate-limited"
  | "network"
  | "unknown";

interface TestOpenAiResult {
  ok: boolean;
  reason?: TestOpenAiReason;
}

const UPSTREAM_URL = "https://api.openai.com/v1/models";
const UPSTREAM_TIMEOUT_MS = 10_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildResult(
  ok: boolean,
  reason?: TestOpenAiReason,
): TestOpenAiResult {
  return reason === undefined ? { ok } : { ok, reason };
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const policy = evaluateStrictLocalDestination({
    destination: "openai",
    dataClass: "setup-metadata",
    feature: "OpenAI setup key test",
    privacy: "hosted",
  });
  if (!policy.allowed) {
    return Response.json(buildResult(false, "strict-local"), { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // Empty body or malformed JSON is treated as "missing" rather
    // than 400. The UI flow for "you forgot to send a key" and "you
    // sent an empty string" should be identical.
    return Response.json(buildResult(false, "missing"), { status: 400 });
  }

  if (!isPlainObject(raw)) {
    return Response.json(buildResult(false, "missing"), { status: 400 });
  }

  const { key } = raw as TestOpenAiRequestBody;
  if (typeof key !== "string" || key.trim().length === 0) {
    return Response.json(buildResult(false, "missing"), { status: 400 });
  }

  const trimmed = key.trim();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${trimmed}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch {
    // Timeout, DNS failure, TLS failure, socket hangup — from the
    // user's perspective these are all "network". Avoid logging the
    // error object: some fetch implementations attach the request
    // which includes the Authorization header.
    clearTimeout(timer);
    return Response.json(buildResult(false, "network"));
  }
  clearTimeout(timer);

  if (upstream.ok) {
    return Response.json(buildResult(true));
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return Response.json(buildResult(false, "unauthorized"));
  }
  if (upstream.status === 429) {
    return Response.json(buildResult(false, "rate-limited"));
  }
  return Response.json(buildResult(false, "unknown"));
}
