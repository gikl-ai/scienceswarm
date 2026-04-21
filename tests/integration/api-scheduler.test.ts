import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock external dependencies used by the scheduler
vi.mock("@/lib/openhands", () => ({
  startConversation: vi.fn().mockResolvedValue({ id: "conv-1" }),
  getConversation: vi.fn().mockResolvedValue({ execution_status: "idle" }),
}));

vi.mock("@/lib/message-handler", () => ({
  completeChat: vi.fn().mockResolvedValue("analysis result"),
}));

import {
  GET,
  POST,
  PATCH,
  DELETE,
} from "@/app/api/scheduler/route";

import {
  getJobs,
  deleteJob,
  scheduleJob,
} from "@/lib/scheduler";

describe("/api/scheduler", () => {
  // Clean up jobs between tests to avoid cross-contamination
  beforeEach(() => {
    for (const job of getJobs()) {
      deleteJob(job.id);
    }
  });

  it("rejects non-local scheduler access", async () => {
    const post = await POST(new Request("http://example.com/api/scheduler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "schedule-job",
        job: {
          name: "Remote Script",
          type: "once",
          action: { type: "run-script", script: "echo unsafe" },
        },
      }),
    }));
    const get = await GET(new Request("http://example.com/api/scheduler"));
    const patch = await PATCH(new Request("http://example.com/api/scheduler", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "job-1", action: "pause" }),
    }));
    const del = await DELETE(new Request("http://example.com/api/scheduler?id=job-1"));

    expect(post.status).toBe(403);
    expect(get.status).toBe(403);
    expect(patch.status).toBe(403);
    expect(del.status).toBe(403);
  });

  // ── POST: schedule-job ─────────────────────────────────────────

  describe("POST action: schedule-job", () => {
    it("creates a job and returns its ID", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Test Job",
            type: "once",
            action: { type: "ai-analysis", config: { prompt: "hello" } },
          },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.id).toBeDefined();
      expect(body.status).toBe("scheduled");
    });

    it("returns 400 when name is missing", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: { action: { type: "ai-analysis" } },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("returns 400 when action is missing", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: { name: "Test" },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("returns 400 for invalid job type", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Test",
            type: "invalid",
            action: { type: "ai-analysis" },
          },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("returns 400 when recurring job lacks schedule", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Recurring",
            type: "recurring",
            action: { type: "ai-analysis" },
          },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("schedule");
    });

    it("rejects empty recurring schedules and event triggers", async () => {
      const recurringRequest = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Recurring",
            type: "recurring",
            schedule: "   ",
            action: { type: "ai-analysis" },
          },
        }),
      });

      const eventRequest = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "On Event",
            type: "on-event",
            triggerEvent: "   ",
            action: { type: "ai-analysis" },
          },
        }),
      });

      expect((await POST(recurringRequest)).status).toBe(400);
      expect((await POST(eventRequest)).status).toBe(400);
    });

    it("rejects unparseable runAt values", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Bad Date",
            type: "once",
            runAt: "not-a-date",
            action: { type: "ai-analysis" },
          },
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain("valid ISO date");
    });

    it("rejects unknown action types", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Bad Action",
            type: "once",
            action: { type: "totally-unknown" },
          },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("rejects frontier watch jobs without a project", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Frontier Watch",
            type: "recurring",
            schedule: "30 8 * * *",
            action: { type: "frontier-watch", config: {} },
          },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });

    it("preserves exact minutes when scheduling recurring jobs", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Half Past",
            type: "recurring",
            schedule: "30 8 * * *",
            timezone: "America/Los_Angeles",
            action: { type: "ai-analysis", config: { prompt: "hello" } },
          },
        }),
      });

      const response = await POST(request);
      const body = await response.json();
      const job = getJobs().find((entry) => entry.id === body.id);

      expect(response.status).toBe(200);
      expect(job?.schedule).toBe("30 8 * * *");
      expect(job?.timezone).toBe("America/Los_Angeles");
      expect(job?.nextRun?.getMinutes()).toBe(30);
    });

    it("uses the configured timezone when computing recurring nextRun", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
      let jobId: string | undefined;

      try {
        jobId = scheduleJob({
          name: "New York Morning",
          type: "recurring",
          schedule: "0 9 * * *",
          timezone: "America/New_York",
          action: { type: "ai-analysis", config: { prompt: "hello" } },
        });

        const job = getJobs().find((entry) => entry.id === jobId);
        expect(job?.nextRun?.toISOString()).toBe("2026-01-01T14:00:00.000Z");
      } finally {
        if (jobId) deleteJob(jobId);
        vi.useRealTimers();
      }
    });

    it("supports comma-separated weekly day cron schedules", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-06T09:00:00.000Z"));
      let jobId: string | undefined;

      try {
        jobId = scheduleJob({
          name: "Tuesday and Thursday Morning",
          type: "recurring",
          schedule: "30 8 * * 2,4",
          timezone: "UTC",
          action: { type: "ai-analysis", config: { prompt: "hello" } },
        });

        const job = getJobs().find((entry) => entry.id === jobId);
        expect(job?.nextRun?.toISOString()).toBe("2026-04-07T08:30:00.000Z");
      } finally {
        if (jobId) deleteJob(jobId);
        vi.useRealTimers();
      }
    });

    it("does not treat constrained day-of-month cron schedules as daily", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-09T10:15:00.000Z"));

      try {
        const request = new Request("http://localhost/api/scheduler", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "schedule-job",
            job: {
              name: "Monthly-ish",
              type: "recurring",
              schedule: "30 8 1 * *",
              action: { type: "ai-analysis", config: { prompt: "hello" } },
            },
          }),
        });

        const response = await POST(request);
        const body = await response.json();
        const job = getJobs().find((entry) => entry.id === body.id);

        expect(response.status).toBe(200);
        expect(job?.nextRun?.toISOString()).toBe("2026-04-09T11:15:00.000Z");

        deleteJob(body.id);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── GET: list jobs ─────────────────────────────────────────────

  describe("GET — list jobs", () => {
    it("lists all jobs including newly created ones", async () => {
      // Create a job first
      const createReq = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Listed Job",
            type: "once",
            action: { type: "ai-analysis" },
          },
        }),
      });
      await POST(createReq);

      const listReq = new Request("http://localhost/api/scheduler");
      const response = await GET(listReq);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.jobs).toBeDefined();
      expect(body.jobs.length).toBeGreaterThanOrEqual(1);
      expect(body.jobs.some((j: { name: string }) => j.name === "Listed Job")).toBe(true);
    });

    it("returns a specific job by id", async () => {
      const createReq = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "Specific Job",
            type: "once",
            action: { type: "ai-analysis" },
          },
        }),
      });
      const createRes = await POST(createReq);
      const { id } = await createRes.json();

      const getReq = new Request(
        `http://localhost/api/scheduler?type=job&id=${id}`,
      );
      const response = await GET(getReq);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.name).toBe("Specific Job");
    });

    it("returns 404 for non-existent job", async () => {
      const request = new Request(
        "http://localhost/api/scheduler?type=job&id=nonexistent",
      );
      const response = await GET(request);
      expect(response.status).toBe(404);
    });
  });

  // ── POST: create-pipeline ──────────────────────────────────────

  describe("POST action: create-pipeline", () => {
    it("validates that steps must be a non-empty array", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-pipeline",
          pipeline: {
            name: "Bad Pipeline",
            steps: [],
          },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain("steps");
    });

    it("creates a pipeline with valid steps", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-pipeline",
          pipeline: {
            name: "Data Pipeline",
            steps: [
              {
                name: "Parse",
                type: "transform",
                config: { format: "csv" },
              },
            ],
          },
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.id).toBeDefined();
      expect(body.pipeline.name).toBe("Data Pipeline");
    });
  });

  // ── POST: unknown action ───────────────────────────────────────

  describe("POST — unknown action", () => {
    it("returns 400 for unknown action", async () => {
      const request = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "explode" }),
      });

      const response = await POST(request);
      expect(response.status).toBe(400);
    });
  });

  // ── DELETE ─────────────────────────────────────────────────────

  describe("DELETE", () => {
    it("returns 400 when id is missing", async () => {
      const request = new Request("http://localhost/api/scheduler");
      const response = await DELETE(request);
      expect(response.status).toBe(400);
    });

    it("deletes a job by id", async () => {
      // Create first
      const createReq = new Request("http://localhost/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule-job",
          job: {
            name: "To Delete",
            type: "once",
            action: { type: "ai-analysis" },
          },
        }),
      });
      const createRes = await POST(createReq);
      const { id } = await createRes.json();

      // Delete
      const deleteReq = new Request(
        `http://localhost/api/scheduler?id=${id}`,
      );
      const response = await DELETE(deleteReq);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.deleted).toBe(id);

      // Verify it's gone
      const getReq = new Request(
        `http://localhost/api/scheduler?type=job&id=${id}`,
      );
      const getRes = await GET(getReq);
      expect(getRes.status).toBe(404);
    });
  });

  describe("durable state", () => {
    it("persists jobs to disk and reloads them after a fresh import", async () => {
      const originalDataRoot = process.env.SCIENCESWARM_DIR;
      const root = join(tmpdir(), `scienceswarm-scheduler-${Date.now()}`);
      rmSync(root, { recursive: true, force: true });
      process.env.SCIENCESWARM_DIR = root;

      try {
        vi.resetModules();
        const scheduler = await import("@/lib/scheduler");

        const jobId = scheduler.scheduleJob({
          name: "Persisted Job",
          type: "once",
          runAt: new Date(Date.now() + 60_000),
          action: { type: "ai-analysis", config: { prompt: "persist" } },
        });

        const statePath = join(root, "brain", "state", "schedules", "jobs.json");
        expect(existsSync(statePath)).toBe(true);
        const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as {
          jobs: Record<string, { name: string }>;
        };
        expect(persisted.jobs[jobId]?.name).toBe("Persisted Job");

        vi.resetModules();
        const reloadedScheduler = await import("@/lib/scheduler");
        expect(reloadedScheduler.getJob(jobId)?.name).toBe("Persisted Job");
        reloadedScheduler.deleteJob(jobId);
        scheduler.deleteJob(jobId);
      } finally {
        if (originalDataRoot) process.env.SCIENCESWARM_DIR = originalDataRoot;
        else delete process.env.SCIENCESWARM_DIR;
        rmSync(root, { recursive: true, force: true });
        vi.resetModules();
      }
    });

    it("resets running jobs to failed on reload after an interrupted run", async () => {
      const originalDataRoot = process.env.SCIENCESWARM_DIR;
      const root = join(tmpdir(), `scienceswarm-scheduler-reload-${Date.now()}`);
      rmSync(root, { recursive: true, force: true });
      process.env.SCIENCESWARM_DIR = root;

      try {
        vi.resetModules();
        const scheduler = await import("@/lib/scheduler");

        const jobId = scheduler.scheduleJob({
          name: "Interrupted Job",
          type: "once",
          runAt: new Date(Date.now() + 60_000),
          action: { type: "ai-analysis", config: { prompt: "persist" } },
        });

        const statePath = join(root, "brain", "state", "schedules", "jobs.json");
        const persisted = JSON.parse(readFileSync(statePath, "utf-8")) as {
          jobs: Record<string, { status: string; logs: string[] }>;
        };
        persisted.jobs[jobId].status = "running";
        persisted.jobs[jobId].logs.push("[test] interrupted during run");
        writeFileSync(statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");

        vi.resetModules();
        const reloadedScheduler = await import("@/lib/scheduler");
        const reloadedJob = reloadedScheduler.getJob(jobId);

        expect(reloadedJob?.status).toBe("failed");
        expect(reloadedJob?.logs.at(-1)).toContain('Reset from "running" to "failed"');

        reloadedScheduler.deleteJob(jobId);
      } finally {
        if (originalDataRoot) process.env.SCIENCESWARM_DIR = originalDataRoot;
        else delete process.env.SCIENCESWARM_DIR;
        rmSync(root, { recursive: true, force: true });
        vi.resetModules();
      }
    });
  });
});
