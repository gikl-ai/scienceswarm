import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_PORTS } from "../../src/lib/config/ports";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
  overrides?: {
    gbrain?: {
      "@electric-sql/pglite"?: string;
    };
  };
  scripts: Record<string, string>;
};
const startScript = fs.readFileSync("start.sh", "utf-8");

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

  it("forces gbrain to reuse the hoisted PGLite package", () => {
    expect(pkg.overrides?.gbrain?.["@electric-sql/pglite"]).toBe("0.4.4");
  });

  it("keeps optional HTTPS dev server support on explicit ScienceSwarm certificate paths", () => {
    expect(startScript).toContain("FRONTEND_HTTPS_KEY=\"$DATA_ROOT/certificates/localhost-key.pem\"");
    expect(startScript).toContain("FRONTEND_HTTPS_CERT=\"$DATA_ROOT/certificates/localhost.pem\"");
    expect(startScript).toContain("--experimental-https-key");
    expect(startScript).toContain("--experimental-https-cert");
    expect(startScript).toContain("openssl req -x509");
  });
});
