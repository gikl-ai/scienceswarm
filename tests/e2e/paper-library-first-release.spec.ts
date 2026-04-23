import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

const ENV_PATH = join(process.cwd(), ".env");
const READY_ENV_LINES = [
  "AGENT_BACKEND=openclaw",
  "LLM_PROVIDER=local",
  "OLLAMA_MODEL=gemma4:latest",
];
const RESET_ENV_LINES = [
  "AGENT_BACKEND=",
  "LLM_PROVIDER=",
  "OLLAMA_MODEL=",
];
const FAR_FUTURE_EXPIRY = "3026-04-23T13:00:00.000Z";
const FAR_FUTURE_APPROVED_AT = "3026-04-23T12:30:00.000Z";
let originalEnvContents: string | null = null;
let hadOriginalEnv = false;

test.beforeEach(async () => {
  hadOriginalEnv = existsSync(ENV_PATH);
  originalEnvContents = hadOriginalEnv ? readFileSync(ENV_PATH, "utf8") : null;
  const nextEnv = originalEnvContents
    ? `${originalEnvContents.trimEnd()}\n${READY_ENV_LINES.join("\n")}\n`
    : `${READY_ENV_LINES.join("\n")}\n`;

  writeFileSync(ENV_PATH, nextEnv);
});

test.afterEach(async () => {
  const cleanupEnv = originalEnvContents
    ? `${originalEnvContents.trimEnd()}\n${RESET_ENV_LINES.join("\n")}\n`
    : `${RESET_ENV_LINES.join("\n")}\n`;
  writeFileSync(ENV_PATH, cleanupEnv);
});

test.afterAll(async () => {
  if (hadOriginalEnv && originalEnvContents !== null) {
    writeFileSync(ENV_PATH, originalEnvContents);
    return;
  }

  rmSync(ENV_PATH, { force: true });
});

test("paper library command center supports review, apply, and undo flows", async ({ page }) => {
  let scanStatus: "review" | "apply" | "applied" | "undone" = "review";
  let approved = false;
  let applied = false;
  let undone = false;

  await page.route("**/api/brain/status", async (route) => {
    await route.fulfill(json({ pageCount: 4, backend: "gbrain" }));
  });

  await page.route("**/api/brain/brief?project=demo-project", async (route) => {
    await route.fulfill(json({ project: "demo-project", dueTasks: [], frontier: [] }));
  });

  await page.route(/.*\/api\/brain\/paper-library\/scan(\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill(json({ ok: true, scanId: "scan-1" }));
      return;
    }

    await route.fulfill(json({
      ok: true,
      scan: {
        version: 1,
        id: "scan-1",
        project: "demo-project",
        rootPath: "/tmp/library",
        rootRealpath: "/tmp/library",
        status: scanStatus === "review" ? "ready_for_review" : "ready_for_apply",
        createdAt: "2026-04-23T12:00:00.000Z",
        updatedAt: "2026-04-23T12:05:00.000Z",
        counters: {
          detectedFiles: 4,
          identified: 4,
          needsReview: scanStatus === "review" ? 1 : 0,
          readyForApply: 1,
          failed: 0,
        },
        warnings: [],
        currentPath: null,
        reviewShardIds: ["0001"],
        applyPlanId: scanStatus === "review" ? undefined : "plan-1",
      },
    }));
  });

  await page.route("**/api/brain/paper-library/review?*", async (route) => {
    await route.fulfill(json({
      ok: true,
      items: scanStatus === "review"
        ? [
            {
              id: "review-1",
              scanId: "scan-1",
              paperId: "paper-1",
              state: "needs_review",
              reasonCodes: ["low_confidence_title"],
              source: {
                relativePath: "2024 - Smith - Interesting Paper.pdf",
                rootRealpath: "/tmp/library",
                size: 12,
                mtimeMs: 1000,
                fingerprint: "quick-fingerprint",
                fingerprintStrength: "quick",
                symlink: false,
              },
              candidates: [
                {
                  id: "candidate-1",
                  identifiers: { doi: "10.1000/interesting" },
                  title: "Interesting Paper",
                  authors: ["Smith"],
                  year: 2024,
                  venue: "Journal of Interesting Results",
                  source: "filename",
                  confidence: 0.82,
                  evidence: [],
                  conflicts: [],
                },
              ],
              selectedCandidateId: "candidate-1",
              version: 1,
              updatedAt: "2026-04-23T12:05:00.000Z",
            },
          ]
        : [],
      totalCount: scanStatus === "review" ? 1 : 0,
      filteredCount: scanStatus === "review" ? 1 : 0,
    }));
  });

  await page.route("**/api/brain/paper-library/review", async (route) => {
    scanStatus = "apply";
    await route.fulfill(json({ ok: true, remainingCount: 0 }));
  });

  await page.route(/.*\/api\/brain\/paper-library\/apply-plan(\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill(json({ ok: true, applyPlanId: "plan-1" }));
      return;
    }

    await route.fulfill(json({
      ok: true,
      plan: {
        version: 1,
        id: "plan-1",
        scanId: "scan-1",
        project: "demo-project",
        status: applied ? "applied" : approved ? "approved" : "validated",
        rootPath: "/tmp/library",
        rootRealpath: "/tmp/library",
        templateFormat: "{year} - {title}.pdf",
        operationCount: 1,
        conflictCount: 0,
        operationShardIds: ["0001"],
        planDigest: "digest",
        approvalTokenHash: approved ? "token-hash" : undefined,
        approvalExpiresAt: approved ? FAR_FUTURE_EXPIRY : undefined,
        approvedAt: approved ? FAR_FUTURE_APPROVED_AT : undefined,
        manifestId: applied ? "manifest-1" : undefined,
        createdAt: "2026-04-23T12:20:00.000Z",
        updatedAt: "2026-04-23T12:20:00.000Z",
      },
      operations: [
        {
          id: "operation-1",
          paperId: "paper-1",
          kind: "rename",
          source: {
            relativePath: "2024 - Smith - Interesting Paper.pdf",
            rootRealpath: "/tmp/library",
            size: 12,
            mtimeMs: 1000,
            fingerprint: "quick-fingerprint",
            fingerprintStrength: "quick",
            symlink: false,
          },
          destinationRelativePath: "2024 - Interesting Paper.pdf",
          reason: "Paper library template proposal",
          confidence: 0.82,
          conflictCodes: [],
        },
      ],
      totalCount: 1,
      filteredCount: 1,
    }));
  });

  await page.route("**/api/brain/paper-library/apply-plan/approve", async (route) => {
    approved = true;
    await route.fulfill(json({
      ok: true,
      approvalToken: "approval-token",
      expiresAt: FAR_FUTURE_EXPIRY,
    }));
  });

  await page.route("**/api/brain/paper-library/apply", async (route) => {
    applied = true;
    scanStatus = "applied";
    await route.fulfill(json({ ok: true, manifestId: "manifest-1" }));
  });

  await page.route("**/api/brain/paper-library/manifest?*", async (route) => {
    await route.fulfill(json({
      ok: true,
      manifest: {
        version: 1,
        id: "manifest-1",
        project: "demo-project",
        applyPlanId: "plan-1",
        status: undone ? "undone" : "applied",
        rootRealpath: "/tmp/library",
        planDigest: "digest",
        operationCount: 1,
        appliedCount: 1,
        failedCount: 0,
        undoneCount: undone ? 1 : 0,
        operationShardIds: ["0001"],
        warnings: [],
        createdAt: "2026-04-23T12:31:00.000Z",
        updatedAt: "2026-04-23T12:31:00.000Z",
      },
      operations: [
        {
          operationId: "operation-1",
          paperId: "paper-1",
          sourceRelativePath: "2024 - Smith - Interesting Paper.pdf",
          destinationRelativePath: "2024 - Interesting Paper.pdf",
          status: undone ? "undone" : "verified",
          appliedAt: "2026-04-23T12:31:00.000Z",
          undoneAt: undone ? "2026-04-23T12:35:00.000Z" : undefined,
        },
      ],
      totalCount: 1,
      filteredCount: 1,
    }));
  });

  await page.route("**/api/brain/paper-library/undo", async (route) => {
    undone = true;
    await route.fulfill(json({ ok: true }));
  });

  await page.goto("/dashboard/gbrain?name=demo-project&view=paper-library");

  await page.getByPlaceholder("/Users/you/Research Papers").fill("/tmp/library");
  await page.getByRole("button", { name: "Start dry-run scan" }).click();
  await expect(page.getByText("ready for review", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open review queue" }).click();
  await expect(page.getByText("Interesting Paper (2024)")).toBeVisible();
  await page.getByRole("button", { name: "Accept selected" }).click();

  await page.getByRole("button", { name: /^Apply\s+1$/ }).click();
  await page.getByRole("button", { name: /preview/i }).click();
  await expect(page.getByText("1 operations")).toBeVisible();
  await page.getByRole("button", { name: "Approve plan" }).click();
  await expect(page.getByText(/Plan approved until/)).toBeVisible();

  await page.getByRole("button", { name: "Apply approved plan" }).click();
  await expect(page.getByText("Manifest and undo")).toBeVisible();
  await expect(page.getByText("1 applied")).toBeVisible();

  await page.getByRole("button", { name: "Undo changes" }).click();
  await expect(page.getByText("1 undone")).toBeVisible();
});
