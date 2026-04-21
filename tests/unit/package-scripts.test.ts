import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_PORTS } from "../../src/lib/config/ports";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
  scripts: Record<string, string>;
};

describe("package.json scripts", () => {
  // Regression: `next dev` alone falls back to Next.js's built-in default
  // of port 3000, which collides with OpenHands and contradicts the
  // documented frontend default. The `dev` script must delegate port
  // resolution to `scripts/print-port.ts frontend`, which reads from
  // `src/lib/config/ports.ts:getFrontendPort` — the single source of
  // truth that honors FRONTEND_PORT > PORT > DEFAULT_PORTS.frontend.
  it("npm run dev delegates port resolution to the central config module", () => {
    const dev = pkg.scripts.dev ?? "";
    expect(dev).toContain("next dev");
    expect(dev).toContain("-p ");
    expect(dev).toMatch(/scripts\/print-port\.ts\s+frontend/);
    // Must NOT hardcode a literal port number — that would drift from
    // DEFAULT_PORTS.frontend and require keeping two places in sync.
    expect(dev).not.toMatch(
      new RegExp(`(?<![A-Za-z0-9_])${DEFAULT_PORTS.frontend}(?![A-Za-z0-9_])`),
    );
    // Must NOT be the bare "next dev" form that defaults to 3000.
    expect(dev).not.toMatch(/^next dev\s*$/);
  });
});
