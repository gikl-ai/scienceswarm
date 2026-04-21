import { beforeEach, describe, expect, it, vi } from "vitest";

const { mkdirMock, appendFileMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  appendFileMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("fs", () => ({
  promises: {
    mkdir: mkdirMock,
    appendFile: appendFileMock,
  },
}));

import { POST } from "@/app/api/structured-critique/feedback/route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/structured-critique/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/structured-critique/feedback", () => {
  beforeEach(() => {
    mkdirMock.mockClear();
    appendFileMock.mockClear();
  });

  it("accepts valid feedback and returns 200 with ok: true", async () => {
    const response = await POST(
      makeRequest({
        job_id: "job-abc",
        finding_id: "finding-1",
        useful: true,
        would_revise: false,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    expect(mkdirMock).toHaveBeenCalledOnce();
    expect(appendFileMock).toHaveBeenCalledOnce();

    const writtenLine = appendFileMock.mock.calls[0][1] as string;
    const record = JSON.parse(writtenLine.trim());
    expect(record.job_id).toBe("job-abc");
    expect(record.finding_id).toBe("finding-1");
    expect(record.useful).toBe(true);
    expect(record.would_revise).toBe(false);
    expect(record.timestamp).toBeDefined();
    expect(record).not.toHaveProperty("comment");
  });

  it("rejects a request missing job_id with 400", async () => {
    const response = await POST(
      makeRequest({
        finding_id: "finding-1",
        useful: true,
        would_revise: false,
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("job_id");
  });

  it("rejects a request missing finding_id with 400", async () => {
    const response = await POST(
      makeRequest({
        job_id: "job-abc",
        useful: true,
        would_revise: false,
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("finding_id");
  });

  it("rejects a request missing useful field with 400", async () => {
    const response = await POST(
      makeRequest({
        job_id: "job-abc",
        finding_id: "finding-1",
        would_revise: false,
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("useful");
  });

  it("rejects a request missing would_revise field with 400", async () => {
    const response = await POST(
      makeRequest({
        job_id: "job-abc",
        finding_id: "finding-1",
        useful: true,
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("would_revise");
  });

  it("rejects malformed JSON with 400", async () => {
    const response = await POST(
      new Request("http://localhost/api/structured-critique/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "this is not json{",
      }),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid JSON");
  });

  it("preserves an optional comment in the written record", async () => {
    const response = await POST(
      makeRequest({
        job_id: "job-abc",
        finding_id: "finding-1",
        useful: false,
        would_revise: true,
        comment: "This finding was not relevant to my methods section.",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });

    const writtenLine = appendFileMock.mock.calls[0][1] as string;
    const record = JSON.parse(writtenLine.trim());
    expect(record.comment).toBe("This finding was not relevant to my methods section.");
  });

  it("rejects a null JSON body with 400", async () => {
    const response = await POST(makeRequest(null));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBeDefined();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });
});
