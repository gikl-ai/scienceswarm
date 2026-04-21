import { test, expect } from "@playwright/test";

/**
 * Spec 4 — Playwright scientist smoke flow.
 *
 * What this test actually asserts (and why it's scoped this way)
 * ---------------------------------------------------------------
 *
 * The intended end-state smoke test is a full "connect OpenClaw →
 * warm-start → ask Photo 51"
 * happy path that ends with the chat assistant citing the
 * `franklin-photo-51.md` fixture by filename. That end-to-end path
 * is not reachable today for two honest reasons:
 *
 *   1. `/setup` needs a real local runtime and Telegram-linked phone
 *      number (OpenClaw + Ollama/Gemma + Telegram login). A
 *      clean CI runner has none of those, so any smoke test that
 *      tries to click through the full installer would surface
 *      "runtime not ready" rather than the bugs we're actually
 *      hunting.
 *
 *   2. The main project workspace at `src/app/dashboard/project/`
 *      still runs on demo data by design. The chat pane does
 *      not currently thread the gbrain-backed search into its
 *      answers, so even if we could get the brain installed there
 *      is no production code path for "assistant answer cites
 *      corpus" to assert against. Faking it would be worse than
 *      nothing.
 *
 * What this smoke DOES assert is the first honest layer that's
 * actually wired through real code:
 *
 *   • /setup renders the expected top-level chrome (header,
 *     status pill, Connect my OpenClaw section) without JavaScript
 *     errors or 500s. This catches hydration failures,
 *     broken imports, and route renames — all of which have bit
 *     us before during the pivot.
 *
 *   • /dashboard/project redirects a fresh install to /setup.
 *     The dashboard layout is a server-component guard that
 *     re-reads `.env` on every request and redirects until
 *     OpenClaw + Ollama are configured. Pinning the redirect is
 *     the honest version of the dashboard smoke for a clean
 *     environment — asserting on the demo workspace chrome is
 *     deferred until the smoke can pre-seed a "ready" config.
 *
 *   • `/api/brain/status` responds with a real JSON shape. This
 *     is the one "hot" API path the dashboard brain card depends
 *     on, and it's cheap to hit end-to-end.
 *
 * The "ask Photo 51" assertion is deliberately deferred — see the
 * `test.fixme` block at the bottom of this file for the exact
 * selector sketch so the next PR can light it up once the chat
 * pane is wired to real gbrain search.
 *
 * Environment
 * -----------
 * The dev server is spawned by `playwright.config.ts` → `webServer`,
 * which reads `E2E_TMP_HOME` from `tests/e2e/global-setup.ts` and
 * forwards it as `SCIENCESWARM_HOME` / `SCIENCESWARM_DIR` /
 * `BRAIN_ROOT`. `SCIENCESWARM_USER_HANDLE=smoke-test` is set in the
 * same place — decision 3A makes it mandatory for every write path.
 */

test.describe("scientist smoke — render happy path", () => {
  test("/setup renders the install chrome without client errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => {
      consoleErrors.push(`pageerror: ${err.message}`);
    });
    // Ignore the handful of noisy dev-server messages that aren't
    // real product failures. Anything else is a failure — the point
    // of the smoke is to catch hydration, import, and 5xx bugs.
    const CONSOLE_ALLOWLIST = [
      "Fast Refresh",
      "DevTools",
      "React DevTools",
    ];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (CONSOLE_ALLOWLIST.some((needle) => text.includes(needle))) return;
      consoleErrors.push(`console.error: ${text}`);
    });

    const response = await page.goto("/setup");
    expect(response?.ok(), "/setup should return a 2xx").toBe(true);

    // Header chrome — matches the H1 in src/app/setup/page.tsx
    // (new simple-onboarding single-screen form).
    await expect(
      page.getByRole("heading", {
        name: /Connect your OpenClaw/,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // The bootstrap form is the full /setup page contract in the
    // new flow. Three inputs + a submit button — asserting all of
    // them catches any hydration or import regression that would
    // mount a partial page tree.
    await expect(page.getByTestId("bootstrap-form")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("handle-input")).toBeVisible();
    await expect(page.getByTestId("email-input")).toBeVisible();
    await expect(page.getByTestId("phone-input")).toBeVisible();
    await expect(page.getByTestId("bootstrap-submit")).toBeVisible();

    expect(
      consoleErrors,
      `Unexpected client-side errors on /setup:\n${consoleErrors.join("\n")}`,
    ).toEqual([]);
  });

  test("/dashboard/project redirects a fresh install to /setup", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // Fresh install behavior: the dashboard layout at
    // `src/app/dashboard/layout.tsx` is a server component that
    // calls `getConfigStatus(process.cwd())` on every request and
    // redirects to `/setup` unless the current `.env` on disk is
    // "ready" (OpenClaw + Ollama configured). In a fresh smoke
    // environment none of that is configured, so the redirect
    // must fire — if it doesn't, a real guard has broken. If
    // something else broke, we'd either get a 5xx or a crash on
    // the way out.
    //
    // Pinning this redirect explicitly is the honest version of
    // the dashboard smoke: we can't assert on the demo workspace
    // chrome without first threading a full local-runtime setup,
    // which is out of scope for the first landing of this suite.
    // See the `test.fixme` at the bottom of this file for the
    // real dashboard assertion.
    const response = await page.goto("/dashboard/project");
    expect(
      response?.ok(),
      "/dashboard/project should resolve to a 2xx after its redirect chain",
    ).toBe(true);

    // After following the redirect chain, the URL should have
    // landed on /setup. Anything else means the guard moved or
    // stopped firing — a real regression.
    expect(
      page.url(),
      "/dashboard/project should redirect a fresh install to /setup",
    ).toContain("/setup");

    // Redirect target should still render the setup chrome. This
    // is redundant with the first test but it closes the loop on
    // "the redirect lands somewhere useful" rather than a blank
    // screen or a crash page.
    await expect(
      page.getByRole("heading", {
        name: /Connect your OpenClaw/,
      }),
    ).toBeVisible({ timeout: 15_000 });

    expect(
      pageErrors,
      `Unexpected pageerror on /dashboard/project redirect chain:\n${pageErrors.join("\n")}`,
    ).toEqual([]);
  });

  test("/api/brain/status responds with a documented shape", async ({
    request,
  }) => {
    const res = await request.get("/api/brain/status");

    // The status route has two legitimate response modes, both
    // of which the smoke must accept:
    //
    //   • 200 OK when BRAIN_ROOT exists on disk — returns a full
    //     health envelope.
    //   • 503 Service Unavailable when no brain is configured
    //     (BRAIN_ROOT points at an empty temp dir, as it does
    //     here — the smoke runs BEFORE the installer is invoked).
    //     See `src/app/api/brain/_shared.ts#getBrainConfig` for
    //     the contract.
    //
    // Anything else — 500, a redirect, an HTML error page, a
    // transport failure — is a real bug. Greptile P1s have
    // landed on this route at least twice during the pivot, so
    // keeping the assertion narrow but strict is the point.
    expect(
      [200, 503],
      `brain status returned unexpected HTTP ${res.status()}`,
    ).toContain(res.status());

    // Both response modes must return a JSON object envelope.
    // An HTML error page (5xx with text/html) would fail `.json()`
    // and catch us before we pin the wrong shape.
    const body = await res.json();
    expect(body, "brain status body should be a JSON object").toEqual(
      expect.any(Object),
    );
    expect(Array.isArray(body)).toBe(false);

    if (res.status() === 503) {
      // The empty-brain path returns an error envelope with a
      // human-readable string. Pin just that one field so future
      // changes to the wording don't blow up, but the wire
      // contract (`{ error: string }`) stays honest.
      expect(typeof (body as { error?: unknown }).error).toBe("string");
    } else {
      // The healthy path's envelope is pinned more rigorously by
      // `tests/integration/gbrain-contract.test.ts` — the smoke
      // just checks the top-level keys the dashboard actually
      // reads, so a silent rename here fails loudly.
      expect(body).toEqual(
        expect.objectContaining({
          backend: expect.any(String),
          pageCount: expect.any(Number),
        }),
      );
    }
  });
});

/**
 * Stretch goal — not yet wired.
 *
 * Once the dashboard chat pane threads gbrain search into its
 * answers (currently blocked on the demo-data boundary documented
 * in `.claude/rules/frontend-dashboard.md`), light this block up
 * to cover the full "ask Photo 51" assertion from Spec 4. The
 * selectors below are sketches — the real ones will need to be
 * confirmed against whatever the chat pane ships.
 *
 * Related: this stays `fixme` until the dashboard chat path is wired
 * to real gbrain-backed search instead of demo-only state.
 */
test.fixme(
  "scientist smoke — full query references Franklin corpus",
  async () => {
    // 1. Install the brain via /setup (needs a local runtime or a
    //    test-only bypass route).
    // 2. Point warm-start at the seeded sample-corpus directory.
    // 3. Open /dashboard/project, type "Who took Photo 51?" into
    //    the chat box, submit.
    // 4. Assert the rendered answer contains "Rosalind Franklin"
    //    and cites "franklin-photo-51.md".
  },
);
