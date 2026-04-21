import { describe, expect, it } from "vitest";

import {
  normalizeStructuredCritiqueJobListPayload,
  normalizeStructuredCritiqueJobPayload,
  normalizeStructuredCritiqueResultPayload,
  StructuredCritiquePayloadValidationError,
} from "@/lib/structured-critique-schema";

describe("structured critique payload schema", () => {
  it("normalizes the Descartes job/result fields consumed by the UI", () => {
    const job = normalizeStructuredCritiqueJobPayload({
      id: "job-123",
      status: "COMPLETED",
      trace_id: "trace-123",
      pdf_filename: "paper.pdf",
      style_profile: "referee",
      result: {
        title: "Audit",
        report_markdown: "# Audit",
        findings: [
          {
            finding_id: "F001",
            severity: "warning",
            description: "The conclusion depends on an unstated assumption.",
            evidence_quote: "Because X, therefore Y.",
            suggested_fix: "State and defend the assumption.",
            argument_id: "ARG-001",
            flaw_type: "missing_assumption",
            broken_link: "premise",
            impact: "Weakens the main conclusion.",
            confidence: 0.84,
            finding_kind: "critique",
          },
        ],
        author_feedback: {
          overall_summary: "Promising but under-supported.",
          appendix_overview: "Extra upstream feedback metadata.",
          top_issues: [
            {
              title: "Missing assumption",
              summary: "The paper never defends a required premise.",
              finding_ids: ["F001"],
            },
          ],
        },
      },
    });

    expect(job.trace_id).toBe("trace-123");
    expect(job.result?.report_markdown).toBe("# Audit");
    expect(job.result?.findings[0]).toMatchObject({
      finding_id: "F001",
      description: "The conclusion depends on an unstated assumption.",
      confidence: 0.84,
      finding_kind: "critique",
    });
    expect(job.result?.author_feedback?.top_issues?.[0]).toMatchObject({
      title: "Missing assumption",
      finding_ids: ["F001"],
    });
    expect(job.result?.author_feedback).toMatchObject({
      appendix_overview: "Extra upstream feedback metadata.",
    });
  });

  it("rejects completed jobs without a result", () => {
    expect(() =>
      normalizeStructuredCritiqueJobPayload({
        id: "job-123",
        status: "COMPLETED",
        result: null,
      }),
    ).toThrow(StructuredCritiquePayloadValidationError);
  });

  it("normalizes hosted job list envelopes", () => {
    const jobs = normalizeStructuredCritiqueJobListPayload({
      jobs: [
        {
          id: "job-123",
          status: "RUNNING",
          pdf_filename: "paper.pdf",
        },
      ],
    });

    expect(jobs).toEqual([
      {
        id: "job-123",
        status: "RUNNING",
        pdf_filename: "paper.pdf",
        style_profile: "professional",
      },
    ]);
  });

  it("rejects blank trace ids when present", () => {
    expect(() =>
      normalizeStructuredCritiqueJobPayload({
        id: "job-123",
        status: "RUNNING",
        trace_id: "   ",
      }),
    ).toThrow(/trace_id/);
  });

  it("rejects malformed finding arrays before consumers read them", () => {
    expect(() =>
      normalizeStructuredCritiqueResultPayload({
        report_markdown: "# Audit",
        findings: [{ severity: "warning" }],
      }),
    ).toThrow(/description is required/);
  });

  it("accepts failed jobs with user-facing error objects", () => {
    const job = normalizeStructuredCritiqueJobPayload({
      id: "job-failed",
      status: "FAILED",
      error: {
        user_facing_message: "The critique pipeline failed before producing findings.",
      },
      error_message: "The critique pipeline failed before producing findings.",
    });

    expect(job.status).toBe("FAILED");
    expect(job.error).toMatchObject({
      user_facing_message: "The critique pipeline failed before producing findings.",
    });
  });

  it("accepts cancelled jobs with terminal error messages", () => {
    const job = normalizeStructuredCritiqueJobPayload({
      id: "job-cancelled",
      status: "CANCELLED",
      error_message:
        "This queued critique was cancelled after you reached the hosted output limit.",
    });

    expect(job.status).toBe("CANCELLED");
    expect(job.error_message).toBe(
      "This queued critique was cancelled after you reached the hosted output limit.",
    );
  });

  it("rejects failed jobs with empty structured error objects", () => {
    expect(() =>
      normalizeStructuredCritiqueJobPayload({
        id: "job-failed",
        status: "FAILED",
        error: {},
      }),
    ).toThrow(/error.user_facing_message/);
  });

  it("preserves explicit null author feedback", () => {
    const result = normalizeStructuredCritiqueResultPayload({
      report_markdown: "# Audit",
      findings: [],
      author_feedback: null,
    });

    expect(result.author_feedback).toBeNull();
  });

  it("requires failed jobs to include an error field even with a result", () => {
    expect(() =>
      normalizeStructuredCritiqueJobPayload({
        id: "job-failed",
        status: "FAILED",
        result: {
          report_markdown: "# Partial report",
          findings: [],
        },
      }),
    ).toThrow(/FAILED jobs must include error or error_message/);
  });
});
