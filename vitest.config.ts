import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // gbrain 0.9 runs PGLite schema migrations (slugify_existing_pages,
    // unique_chunk_index, access_tokens_and_mcp_log) on each test's fresh
    // database. Default 5s test / 10s hook is too tight under parallel load
    // on slower machines or cold Node caches.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Vitest's default include glob also sweeps `.spec.ts`, which
    // collides with the Playwright e2e tests under
    // tests/e2e/*.spec.ts. Exclude that directory from vitest so
    // `npm run test` never tries to execute a Playwright spec inside
    // a vitest worker — Playwright owns tests/e2e/*.spec.ts via
    // `npm run test:e2e` instead. Existing `.test.ts` files under
    // tests/e2e/ (legacy vitest smoke suites) are still picked up.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.worktrees/**",
      "tests/e2e/**/*.spec.ts",
    ],
  },
});
