import {
  ALLOWED_STYLE_PROFILES,
  DEFAULT_STYLE_PROFILE,
  buildServiceHeaders,
  fetchStructuredCritique,
  INVALID_UPSTREAM_RESPONSE_MESSAGE,
  isStructuredCritiqueTimeoutError,
  readErrorDetail,
  readStructuredCritiquePayload,
  resolveStructuredCritiqueFallacyProfile,
  sanitizeStructuredCritiqueMessage,
  submitStructuredCritiqueUpstream,
  StructuredCritiqueInvalidResponseError as InvalidUpstreamResponseError,
  StructuredCritiqueServiceUnavailableError as ServiceUnavailableError,
  StructuredCritiqueTimeoutError,
  validateStructuredCritiqueFileSubmission,
  validateStructuredCritiqueTextSubmission,
  type StructuredCritiqueErrorPayload as ErrorPayload,
} from "@/lib/structured-critique-client";
import {
  getStructuredCritiqueTimeoutMs,
  getStructuredCritiqueConfig,
  StructuredCritiqueConfigError,
  type StructuredCritiqueConfig,
} from "@/lib/structured-critique-config";
import {
  getStructuredCritiqueAuthMessage,
  isBuiltInScienceSwarmCritiqueUrl,
} from "@/lib/scienceswarm-auth";
import { getScienceSwarmLocalAuthorizationFromRequest } from "@/lib/scienceswarm-local-auth";
import {
  normalizeStructuredCritiqueJobListPayload,
  normalizeStructuredCritiqueJobPayload,
  StructuredCritiquePayloadValidationError,
} from "@/lib/structured-critique-schema";
import {
  assertStrictLocalDestinationAllowed,
  StrictLocalPolicyError,
} from "@/lib/runtime/strict-local-policy";

const SUBMISSION_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const SUBMISSION_RATE_LIMIT_MAX = 30;
const SUBMISSION_RATE_LIMIT_MAX_BUCKETS = 4096;

const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

class StructuredCritiqueAuthError extends Error {
  readonly status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "StructuredCritiqueAuthError";
    this.status = status;
  }
}

function clientRateLimitKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "local";
}

function checkSubmissionRateLimit(request: Request): Response | null {
  const now = Date.now();
  const key = clientRateLimitKey(request);
  for (const [bucketKey, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(bucketKey);
    }
  }
  const current = rateLimitBuckets.get(key);

  if (!current && rateLimitBuckets.size >= SUBMISSION_RATE_LIMIT_MAX_BUCKETS) {
    return Response.json(
      {
        error:
          "Structured critique submission capacity is temporarily exhausted. Try again in a few minutes.",
      },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  if (!current || current.resetAt <= now) {
    rateLimitBuckets.set(key, {
      count: 1,
      resetAt: now + SUBMISSION_RATE_LIMIT_WINDOW_MS,
    });
    return null;
  }

  if (current.count >= SUBMISSION_RATE_LIMIT_MAX) {
    return Response.json(
      {
        error:
          "Structured critique submission rate limit exceeded. Try again in a few minutes.",
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
          ),
        },
      },
    );
  }

  current.count += 1;
  return null;
}

function isPdfFile(file: File): boolean {
  const type = file.type.trim().toLowerCase();
  return (
    file.name.toLowerCase().endsWith(".pdf") &&
    (type === "" ||
      type === "application/pdf" ||
      type === "application/octet-stream")
  );
}

function readPublicError(
  err: unknown,
  timeoutMs: number,
): { status: number; error: string } {
  if (err instanceof StrictLocalPolicyError) {
    return { status: 403, error: err.message };
  }
  if (err instanceof StructuredCritiqueConfigError) {
    return { status: 503, error: err.message };
  }
  if (err instanceof StructuredCritiqueAuthError) {
    return { status: err.status, error: err.message };
  }
  if (err instanceof ServiceUnavailableError) {
    return { status: 503, error: err.message };
  }
  if (err instanceof InvalidUpstreamResponseError) {
    return { status: 502, error: err.message };
  }
  if (err instanceof StructuredCritiquePayloadValidationError) {
    return { status: 502, error: INVALID_UPSTREAM_RESPONSE_MESSAGE };
  }
  if (isStructuredCritiqueTimeoutError(err)) {
    return {
      status: 504,
      error: new StructuredCritiqueTimeoutError(timeoutMs).message,
    };
  }
  const message =
    err instanceof Error ? err.message : "Structured critique failed";
  console.error(
    "Structured critique proxy error:",
    sanitizeStructuredCritiqueMessage(
      message,
      structuredCritiqueSecretCandidates(),
    ),
  );
  return {
    status: 500,
    error: "Structured critique proxy failed. Try again in a few minutes.",
  };
}

export async function POST(request: Request) {
  try {
    assertStrictLocalDestinationAllowed({
      destination: "hosted-critique",
      dataClass: "critique-payload",
      feature: "hosted structured critique",
      privacy: "hosted",
    });
    const config = getStructuredCritiqueConfig();
    const authorization = await resolveUpstreamAuthorization(
      config,
      request,
    );
    const formData = await request.formData();
    const fileField = formData.get("file");
    const textField = formData.get("text");
    const styleProfile = String(
      formData.get("style_profile") || DEFAULT_STYLE_PROFILE,
    );
    const fallacyProfile = formData.get("fallacy_profile");

    if (fileField !== null && !(fileField instanceof File)) {
      return Response.json(
        { error: "file must be a PDF upload" },
        { status: 400 },
      );
    }
    if (textField !== null && typeof textField !== "string") {
      return Response.json(
        { error: "text must be a string field" },
        { status: 400 },
      );
    }

    const file = fileField instanceof File ? fileField : null;
    const text = typeof textField === "string" ? textField.trim() : "";
    const hasFile = file !== null;
    const hasText = text.length > 0;

    if (!hasFile && !hasText) {
      return Response.json(
        { error: "Either a file upload or a text field is required" },
        { status: 400 },
      );
    }

    if (hasFile && hasText) {
      return Response.json(
        { error: "Provide either file or text, not both" },
        { status: 400 },
      );
    }

    if (!(ALLOWED_STYLE_PROFILES as ReadonlySet<string>).has(styleProfile)) {
      return Response.json(
        {
          error: `Invalid style_profile. Allowed values: ${JSON.stringify([
            ...ALLOWED_STYLE_PROFILES,
          ])}`,
        },
        { status: 400 },
      );
    }

    if (file && !isPdfFile(file)) {
      return Response.json(
        {
          error:
            "Only PDF uploads with an application/pdf content type are accepted",
        },
        { status: 400 },
      );
    }

    const fileValidation = file
      ? validateStructuredCritiqueFileSubmission(file.size)
      : null;
    if (fileValidation) {
      return Response.json(
        { error: fileValidation.error },
        { status: fileValidation.status },
      );
    }

    const textValidation = hasText
      ? validateStructuredCritiqueTextSubmission(text)
      : null;
    if (textValidation) {
      return Response.json(
        { error: textValidation.error },
        { status: textValidation.status },
      );
    }

    const rateLimitResponse = checkSubmissionRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { payload, response } = await submitStructuredCritiqueUpstream({
      authorization,
      config,
      fallacyProfile: resolveStructuredCritiqueFallacyProfile(
        typeof fallacyProfile === "string" ? fallacyProfile : null,
      ),
      file,
      signal: AbortSignal.timeout(config.timeoutMs),
      styleProfile,
      text,
    });
    if (!response.ok) {
      const detail = readErrorDetail(
        payload as ErrorPayload,
        response,
        structuredCritiqueResponseSecrets(config),
      );
      return Response.json(
        {
          error: buildPublicAuthError(
            config,
            response.status,
            authorization,
            detail,
          ),
        },
        { status: response.status },
      );
    }

    // Public submit intentionally requires the documented async job envelope.
    // The MCP client accepts legacy synchronous result payloads for compatibility.
    const job = normalizeStructuredCritiqueJobPayload(payload);
    return Response.json(job, { status: response.status });
  } catch (err) {
    const publicError = readPublicError(err, getTimeoutFromEnv());
    return Response.json(
      { error: publicError.error },
      { status: publicError.status },
    );
  }
}

export async function GET(request: Request) {
  try {
    assertStrictLocalDestinationAllowed({
      destination: "hosted-critique",
      dataClass: "critique-payload",
      feature: "hosted structured critique polling",
      privacy: "hosted",
    });
    const config = getStructuredCritiqueConfig();
    const authorization = await resolveUpstreamAuthorization(
      config,
      request,
    );
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("job_id");
    const historyRequested =
      searchParams.get("history") === "1" || searchParams.get("list") === "1";
    const limitParam = searchParams.get("limit");
    const trimmedLimitParam = limitParam?.trim() ?? "";
    const limit =
      trimmedLimitParam.length === 0
        ? 20
        : Number.parseInt(trimmedLimitParam, 10);

    if (historyRequested) {
      if (
        (trimmedLimitParam.length > 0 && !/^\d+$/.test(trimmedLimitParam)) ||
        !Number.isFinite(limit) ||
        limit < 1 ||
        limit > 100
      ) {
        return Response.json(
          { error: "limit must be an integer between 1 and 100" },
          { status: 400 },
        );
      }

      const response = await fetchStructuredCritique(
        `${config.baseUrl}/structured-critique?limit=${encodeURIComponent(String(limit))}`,
        {
          method: "GET",
          headers: buildServiceHeaders(config, { authorization }),
          signal: AbortSignal.timeout(config.timeoutMs),
        },
      );

      const payload = (await readStructuredCritiquePayload(
        response,
      )) as ErrorPayload;
      if (!response.ok) {
        const detail = readErrorDetail(
          payload,
          response,
          structuredCritiqueResponseSecrets(config),
        );
        return Response.json(
          {
            error: buildPublicAuthError(
              config,
              response.status,
              authorization,
              detail,
            ),
          },
          { status: response.status },
        );
      }

      const jobs = normalizeStructuredCritiqueJobListPayload(payload);
      return Response.json({ jobs }, { status: response.status });
    }

    if (!jobId?.trim()) {
      return Response.json({ error: "job_id is required" }, { status: 400 });
    }
    if (jobId.length > 200) {
      return Response.json({ error: "job_id is too long" }, { status: 400 });
    }

    const encodedJobId = encodeURIComponent(jobId.trim());
    const response = await fetchStructuredCritique(
      `${config.baseUrl}/structured-critique/${encodedJobId}`,
      {
        method: "GET",
        headers: buildServiceHeaders(config, { authorization }),
        signal: AbortSignal.timeout(config.timeoutMs),
      },
    );

    const payload = (await readStructuredCritiquePayload(
      response,
    )) as ErrorPayload;
    if (!response.ok) {
      const detail = readErrorDetail(
        payload,
        response,
        structuredCritiqueResponseSecrets(config),
      );
      return Response.json(
        {
          error: buildPublicAuthError(
            config,
            response.status,
            authorization,
            detail,
          ),
        },
        { status: response.status },
      );
    }

    const job = normalizeStructuredCritiqueJobPayload(payload);
    return Response.json(job, { status: response.status });
  } catch (err) {
    const publicError = readPublicError(err, getTimeoutFromEnv());
    return Response.json(
      { error: publicError.error },
      { status: publicError.status },
    );
  }
}

function getTimeoutFromEnv(): number {
  return getStructuredCritiqueTimeoutMs();
}

function readForwardedAuthorization(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const match = value.trim().match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) {
    throw new StructuredCritiqueAuthError(
      "Authorization header must use Bearer authentication.",
      400,
    );
  }
  return `Bearer ${match[1].trim()}`;
}

async function resolveUpstreamAuthorization(
  config: StructuredCritiqueConfig,
  request: Request,
): Promise<string | null> {
  const forwarded = readForwardedAuthorization(request);
  if (forwarded) {
    return isBuiltInScienceSwarmCritiqueUrl(config.baseUrl) ? forwarded : null;
  }
  if (!isBuiltInScienceSwarmCritiqueUrl(config.baseUrl)) {
    return null;
  }
  return getScienceSwarmLocalAuthorizationFromRequest(request);
}

function buildPublicAuthError(
  config: StructuredCritiqueConfig,
  status: number,
  authorization: string | null,
  fallback: string,
): string {
  if (
    config.authMode === "user_session" &&
    (status === 401 || status === 403)
  ) {
    return getStructuredCritiqueAuthMessage(Boolean(authorization));
  }
  return fallback;
}

function structuredCritiqueSecretCandidates(): string[] {
  const token = process.env.STRUCTURED_CRITIQUE_SERVICE_TOKEN?.trim();
  return token ? [token] : [];
}

function structuredCritiqueResponseSecrets(
  config: StructuredCritiqueConfig,
): string[] {
  return config.token ? [config.token] : [];
}
