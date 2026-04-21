export const STRUCTURED_CRITIQUE_STATUSES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const;

export type StructuredCritiqueStatus =
  (typeof STRUCTURED_CRITIQUE_STATUSES)[number];

export type StructuredCritiqueFinding = {
  finding_id?: string;
  severity?: string;
  description: string;
  evidence_quote?: string;
  suggested_fix?: string;
  argument_id?: string;
  flaw_type?: string;
  broken_link?: string;
  impact?: string;
  confidence?: number;
  finding_kind?: string;
};

export type StructuredCritiqueResult = {
  title?: string;
  report_markdown: string;
  findings: StructuredCritiqueFinding[];
  author_feedback?: {
    overall_summary?: string;
    top_issues?: Array<{
      title?: string;
      summary?: string;
    }>;
  } | null;
} & Record<string, unknown>;

export type StructuredCritiqueJob = {
  id: string;
  status: StructuredCritiqueStatus;
  trace_id?: string | null;
  pdf_filename: string;
  style_profile: string;
  error?: string | { user_facing_message?: string } | null;
  error_message?: string | null;
  result?: StructuredCritiqueResult | null;
} & Record<string, unknown>;

export class StructuredCritiquePayloadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredCritiquePayloadValidationError";
  }
}

const STATUS_SET = new Set<string>(STRUCTURED_CRITIQUE_STATUSES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readOptionalString(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new StructuredCritiquePayloadValidationError(`${path} must be a string`);
  }
  return value;
}

function readOptionalNumber(
  source: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new StructuredCritiquePayloadValidationError(`${path} must be a finite number`);
  }
  return value;
}

function normalizeAuthorFeedback(value: unknown): StructuredCritiqueResult["author_feedback"] {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new StructuredCritiquePayloadValidationError(
      "result.author_feedback must be an object",
    );
  }

  const feedback: NonNullable<StructuredCritiqueResult["author_feedback"]> = {
    ...value,
  };
  const overallSummary = readOptionalString(
    value,
    "overall_summary",
    "result.author_feedback.overall_summary",
  );
  if (value.overall_summary !== null && overallSummary !== undefined) {
    feedback.overall_summary = overallSummary;
  }

  const topIssues = value.top_issues;
  if (topIssues !== undefined && topIssues !== null) {
    if (!Array.isArray(topIssues)) {
      throw new StructuredCritiquePayloadValidationError(
        "result.author_feedback.top_issues must be an array",
      );
    }
    feedback.top_issues = topIssues.map((issue, index) => {
      if (!isRecord(issue)) {
        throw new StructuredCritiquePayloadValidationError(
          `result.author_feedback.top_issues[${index}] must be an object`,
        );
      }
      const normalizedIssue: Record<string, unknown> = {
        ...issue,
      };
      const title = readOptionalString(
        issue,
        "title",
        `result.author_feedback.top_issues[${index}].title`,
      );
      if (issue.title !== null && title !== undefined) {
        normalizedIssue.title = title;
      }
      const summary = readOptionalString(
        issue,
        "summary",
        `result.author_feedback.top_issues[${index}].summary`,
      );
      if (issue.summary !== null && summary !== undefined) {
        normalizedIssue.summary = summary;
      }
      return normalizedIssue;
    });
  }

  return feedback;
}

function normalizeFinding(value: unknown, index: number): StructuredCritiqueFinding {
  if (!isRecord(value)) {
    throw new StructuredCritiquePayloadValidationError(
      `result.findings[${index}] must be an object`,
    );
  }

  const description = readOptionalString(
    value,
    "description",
    `result.findings[${index}].description`,
  );
  if (description === undefined) {
    throw new StructuredCritiquePayloadValidationError(
      `result.findings[${index}].description is required`,
    );
  }

  const normalized: Record<string, unknown> = {
    ...value,
    description,
  };
  assignOptionalString(
    normalized,
    value,
    "finding_id",
    `result.findings[${index}].finding_id`,
  );
  assignOptionalString(
    normalized,
    value,
    "severity",
    `result.findings[${index}].severity`,
  );
  assignOptionalString(
    normalized,
    value,
    "evidence_quote",
    `result.findings[${index}].evidence_quote`,
  );
  assignOptionalString(
    normalized,
    value,
    "suggested_fix",
    `result.findings[${index}].suggested_fix`,
  );
  assignOptionalString(
    normalized,
    value,
    "argument_id",
    `result.findings[${index}].argument_id`,
  );
  assignOptionalString(
    normalized,
    value,
    "flaw_type",
    `result.findings[${index}].flaw_type`,
  );
  assignOptionalString(
    normalized,
    value,
    "broken_link",
    `result.findings[${index}].broken_link`,
  );
  assignOptionalString(
    normalized,
    value,
    "impact",
    `result.findings[${index}].impact`,
  );
  assignOptionalString(
    normalized,
    value,
    "finding_kind",
    `result.findings[${index}].finding_kind`,
  );
  if (value.confidence !== null) {
    const confidence = readOptionalNumber(
      value,
      "confidence",
      `result.findings[${index}].confidence`,
    );
    if (confidence !== undefined) normalized.confidence = confidence;
  }
  return normalized as StructuredCritiqueFinding;
}

function assignOptionalString(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (source[key] === null) return;
  const value = readOptionalString(source, key, path);
  if (value !== undefined) target[key] = value;
}

function normalizeJobError(
  value: unknown,
): StructuredCritiqueJob["error"] | undefined {
  if (value === undefined || value === null) return value ?? undefined;
  if (typeof value === "string") return value;
  if (!isRecord(value)) {
    throw new StructuredCritiquePayloadValidationError(
      "error must be a string, null, or object",
    );
  }

  const userFacingMessage = readOptionalString(
    value,
    "user_facing_message",
    "error.user_facing_message",
  );
  if (userFacingMessage === undefined || userFacingMessage.trim().length === 0) {
    throw new StructuredCritiquePayloadValidationError(
      "error.user_facing_message must be a non-empty string when error is an object",
    );
  }
  return {
    ...value,
    user_facing_message: userFacingMessage,
  };
}

export function normalizeStructuredCritiqueResultPayload(
  payload: unknown,
): StructuredCritiqueResult {
  if (!isRecord(payload)) {
    throw new StructuredCritiquePayloadValidationError("result must be an object");
  }

  const reportMarkdown = payload.report_markdown;
  if (typeof reportMarkdown !== "string") {
    throw new StructuredCritiquePayloadValidationError(
      "result.report_markdown must be a string",
    );
  }

  const findings = payload.findings;
  if (!Array.isArray(findings)) {
    throw new StructuredCritiquePayloadValidationError(
      "result.findings must be an array",
    );
  }

  return {
    ...payload,
    title: readOptionalString(payload, "title", "result.title"),
    report_markdown: reportMarkdown,
    findings: findings.map(normalizeFinding),
    author_feedback: normalizeAuthorFeedback(payload.author_feedback),
  };
}

export function normalizeStructuredCritiqueJobPayload(
  payload: unknown,
): StructuredCritiqueJob {
  if (!isRecord(payload)) {
    throw new StructuredCritiquePayloadValidationError("job payload must be an object");
  }

  if (typeof payload.id !== "string" || payload.id.trim().length === 0) {
    throw new StructuredCritiquePayloadValidationError("id must be a non-empty string");
  }

  if (typeof payload.status !== "string" || !STATUS_SET.has(payload.status)) {
    throw new StructuredCritiquePayloadValidationError(
      "status must be one of PENDING, RUNNING, COMPLETED, CANCELLED, FAILED",
    );
  }
  const status = payload.status as StructuredCritiqueStatus;

  const traceId = readOptionalString(payload, "trace_id", "trace_id");
  if (traceId !== undefined && traceId.trim().length === 0) {
    throw new StructuredCritiquePayloadValidationError(
      "trace_id must be non-empty when present",
    );
  }

  const error = normalizeJobError(payload.error);
  const errorMessage = readOptionalString(
    payload,
    "error_message",
    "error_message",
  );

  const resultPayload = payload.result;
  let result: StructuredCritiqueResult | null | undefined;
  if (resultPayload === undefined || resultPayload === null) {
    result = resultPayload ?? undefined;
  } else {
    result = normalizeStructuredCritiqueResultPayload(resultPayload);
  }

  if (status === "COMPLETED" && !result) {
    throw new StructuredCritiquePayloadValidationError(
      "COMPLETED jobs must include result",
    );
  }

  if ((status === "FAILED" || status === "CANCELLED") && !error && !errorMessage) {
    throw new StructuredCritiquePayloadValidationError(
      `${status} jobs must include error or error_message`,
    );
  }

  return {
    ...payload,
    id: payload.id,
    status,
    trace_id: traceId,
    pdf_filename: readOptionalString(payload, "pdf_filename", "pdf_filename") ?? "",
    style_profile: readOptionalString(payload, "style_profile", "style_profile") ?? "professional",
    error,
    error_message: errorMessage,
    result,
  };
}

export function normalizeStructuredCritiqueJobListPayload(
  payload: unknown,
): StructuredCritiqueJob[] {
  const rawJobs = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.jobs)
      ? payload.jobs
      : null;

  if (!rawJobs) {
    throw new StructuredCritiquePayloadValidationError(
      "structured critique job list payload must be an array or an object with a jobs array",
    );
  }

  return rawJobs.map((job, index) => {
    try {
      return normalizeStructuredCritiqueJobPayload(job);
    } catch (error) {
      if (error instanceof StructuredCritiquePayloadValidationError) {
        throw new StructuredCritiquePayloadValidationError(
          `jobs[${index}] ${error.message}`,
        );
      }
      throw error;
    }
  });
}

export function tryNormalizeStructuredCritiqueJobPayload(
  payload: unknown,
): { ok: true; job: StructuredCritiqueJob } | { ok: false; error: string } {
  try {
    return { ok: true, job: normalizeStructuredCritiqueJobPayload(payload) };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Structured critique payload validation failed",
    };
  }
}
