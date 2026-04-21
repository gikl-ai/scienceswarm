import { test, expect } from "@playwright/test";

/**
 * Hubble e2e demo — drop the PDF, audit, plan, revise, cover letter.
 *
 * This spec is deliberately marked `test.skip` until an operator runs
 * it in a session with a live dev server, OpenClaw, OpenHands, and a
 * working Descartes endpoint. The runbook's Hubble e2e path is
 * explicitly one live Descartes call + one full OpenHands revision
 * sandbox run; both are manual verifications, not CI gates. The spec
 * lives in the repo so:
 *
 *   1. Future runs pick up the exact click path without re-authoring
 *      the Playwright choreography.
 *   2. The flow's expected assertions (gbrain pages, FileTree entries,
 *      chat text) are version-controlled alongside the schema and
 *      MCP tools.
 *
 * To run the live demo:
 *
 *     npm run dev > /tmp/hubble-dev.log 2>&1 &
 *     docker compose up -d openhands
 *     openclaw --profile project-alpha health   # must return reachable
 *     GATE_A_DRY_RUN=0 AUDIT_REVISE_LIVE=1 npx playwright test \\
 *       tests/e2e/audit-revise-hubble-flow.spec.ts
 *
 * Remove the `test.skip` wrapper when `AUDIT_REVISE_LIVE=1`; the spec
 * itself is complete.
 */

const LIVE = process.env.AUDIT_REVISE_LIVE === "1";
const describeOrSkip = LIVE ? test.describe : test.describe.skip;

describeOrSkip("audit-revise — Hubble e2e demo", () => {
  test("drop → audit → plan → revise → cover letter", async ({ page }) => {
    await page.goto("http://localhost:3001/dashboard/project");
    await expect(page).toHaveTitle(/ScienceSwarm/);

    // 1. Drop the fixture PDF onto the FileTree dropzone.
    const dropzone = page.getByTestId("filetree-dropzone");
    await dropzone.setInputFiles(
      "tests/fixtures/audit-revise/hubble-1929.pdf",
    );
    await expect(page.getByText("hubble-1929.pdf", { exact: false })).toBeVisible({
      timeout: 30_000,
    });

    // 2. Ask the agent to audit the paper.
    const chat = page.getByTestId("chat-input");
    await chat.fill(
      "Audit hubble-1929 for everything wrong with it, then propose a revision plan.",
    );
    await chat.press("Enter");

    // Wait up to 15 minutes for the critique brief + plan draft to
    // appear in chat. The agent is expected to call resolve_artifact,
    // critique_artifact, and draft_revision_plan in that order.
    await expect(
      page.getByText("hubble-1929-critique", { exact: false }),
    ).toBeVisible({ timeout: 15 * 60 * 1000 });
    await expect(
      page.getByText("hubble-1929-revision-plan", { exact: false }),
    ).toBeVisible({ timeout: 2 * 60 * 1000 });

    // 3. Approve the plan and run the revision job.
    await chat.fill("Approve the plan and run the revision.");
    await chat.press("Enter");
    await expect(page.getByText(/approved/i)).toBeVisible({
      timeout: 2 * 60 * 1000,
    });
    await expect(page.getByText(/job_/)).toBeVisible({
      timeout: 2 * 60 * 1000,
    });

    // 4. Wait up to 20 minutes for the revision to land.
    await expect(
      page.getByText("hubble-1929-revision", { exact: false }),
    ).toBeVisible({ timeout: 20 * 60 * 1000 });

    // 5. Cover letter.
    await chat.fill("Now draft a cover letter for the editor.");
    await chat.press("Enter");
    await expect(
      page.getByText("hubble-1929-revision-cover-letter", { exact: false }),
    ).toBeVisible({ timeout: 5 * 60 * 1000 });

    // 6. FileTree should show every artifact.
    for (const slug of [
      "hubble-1929",
      "hubble-1929-critique",
      "hubble-1929-revision-plan",
      "hubble-1929-revision",
      "hubble-1929-revision-cover-letter",
    ]) {
      await expect(page.getByText(slug, { exact: false })).toBeVisible();
    }
  });
});
