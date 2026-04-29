import { test, expect } from "@playwright/test";

/**
 * The setup form treats the Telegram phone number as optional.
 * Verify that the user can complete bootstrap without providing one.
 */

test("allows bootstrap without a Telegram phone number", async ({
  page,
}) => {
  let bootstrapCalls = 0;
  await page.route("**/api/setup/bootstrap", async (route) => {
    bootstrapCalls += 1;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: "data: {\"type\":\"summary\",\"status\":\"ok\",\"failed\":[],\"skipped\":[]}\n\n",
    });
  });

  await page.goto("/setup");
  await expect(page.getByTestId("bootstrap-form")).toBeVisible();

  await expect(page.getByTestId("handle-input")).toHaveValue(
    /^researcher-[a-z0-9]{5,8}$/,
  );
  await page.getByTestId("handle-input").fill("testuser");

  // Leave phone empty and submit — bootstrap should proceed.
  await page.getByTestId("bootstrap-submit").click();

  // Bootstrap should have been called (phone is optional now).
  await expect.poll(() => bootstrapCalls).toBeGreaterThan(0);
});
