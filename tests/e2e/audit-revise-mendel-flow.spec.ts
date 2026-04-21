import { test, expect } from "@playwright/test";

/**
 * Mendel e2e demo — the heaviest audit-revise flow.
 *
 * Drop CSV + Python + PDF → audit → plan with scope = full → translate
 * → rerun stats + regenerate figure → revise → cover letter. Four job
 * kinds fire in sequence; each is deferred to a live session the same
 * way the Hubble spec is.
 *
 * The runbook's decision rule for Mendel is that Hubble is filmable
 * alone, so if the live session runs out of time before Mendel
 * completes, Hubble is the v1 demo and Mendel becomes the first
 * follow-up. This spec documents the click path so Mendel is ready to
 * run as soon as the sandbox image and `rerun_stats_and_regenerate_
 * figure` + `translate_paper` job kinds are landed.
 *
 * To run the live demo:
 *
 *     npm run dev > /tmp/mendel-dev.log 2>&1 &
 *     docker compose up -d openhands
 *     openclaw --profile project-alpha health
 *     AUDIT_REVISE_LIVE=1 npx playwright test \\
 *       tests/e2e/audit-revise-mendel-flow.spec.ts
 */

const LIVE = process.env.AUDIT_REVISE_LIVE === "1";
const describeOrSkip = LIVE ? test.describe : test.describe.skip;

describeOrSkip("audit-revise — Mendel e2e demo", () => {
  test("drop → audit → plan → translate → rerun stats → revise → cover letter", async ({ page }) => {
    await page.goto("http://localhost:3001/dashboard/project");

    // 1. Drop the three Mendel fixtures.
    const dropzone = page.getByTestId("filetree-dropzone");
    await dropzone.setInputFiles([
      "tests/fixtures/audit-revise/mendel-1866-textlayer.pdf",
      "tests/fixtures/audit-revise/mendel-counts.csv",
      "tests/fixtures/audit-revise/chisq.py",
    ]);
    for (const file of [
      "mendel-1866",
      "mendel-counts",
      "chisq",
    ]) {
      await expect(page.getByText(file, { exact: false })).toBeVisible({
        timeout: 30_000,
      });
    }

    // 2. Ask the agent for a full-scope audit.
    const chat = page.getByTestId("chat-input");
    await chat.fill(
      "Audit the Mendel paper. Full scope: include the data rerun and the translation.",
    );
    await chat.press("Enter");

    await expect(
      page.getByText("mendel-1866-critique", { exact: false }),
    ).toBeVisible({ timeout: 15 * 60 * 1000 });
    await expect(
      page.getByText("mendel-1866-revision-plan", { exact: false }),
    ).toBeVisible({ timeout: 2 * 60 * 1000 });

    // 3. Approve and run the four jobs in sequence.
    await chat.fill(
      "Approve the plan. Run translate_paper, then rerun_stats_and_regenerate_figure, then revise_paper, then write_cover_letter.",
    );
    await chat.press("Enter");

    await expect(
      page.getByText("mendel-1866-translation-en", { exact: false }),
    ).toBeVisible({ timeout: 20 * 60 * 1000 });
    await expect(
      page.getByText("mendel-1866-stats-rerun", { exact: false }),
    ).toBeVisible({ timeout: 15 * 60 * 1000 });
    await expect(
      page.getByText("mendel-1866-revision", { exact: false }),
    ).toBeVisible({ timeout: 20 * 60 * 1000 });
    await expect(
      page.getByText("mendel-1866-revision-cover-letter", { exact: false }),
    ).toBeVisible({ timeout: 5 * 60 * 1000 });

    // 4. FileTree should show every artifact.
    for (const slug of [
      "mendel-1866",
      "mendel-1866-critique",
      "mendel-1866-revision-plan",
      "mendel-1866-translation-en",
      "mendel-1866-stats-rerun",
      "mendel-1866-stats-rerun-code",
      "mendel-1866-revision",
      "mendel-1866-revision-cover-letter",
    ]) {
      await expect(page.getByText(slug, { exact: false })).toBeVisible();
    }
  });
});
