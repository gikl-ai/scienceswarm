import fs from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULT_PORTS } from "../../src/lib/config/ports";
import { OLLAMA_RECOMMENDED_MODEL_ALIASES } from "../../src/lib/ollama-constants";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8")) as {
  dependencies?: {
    "@electric-sql/pglite"?: string;
  };
  overrides?: {
    gbrain?: {
      "@electric-sql/pglite"?: string;
    };
  };
  scripts: Record<string, string>;
  build?: {
    files?: string[];
  };
};
const startScript = fs.readFileSync("start.sh", "utf-8");
const installScript = fs.readFileSync("install.sh", "utf-8");
const runtimePrereqsScript = fs.readFileSync(
  "scripts/install-runtime-prereqs.sh",
  "utf-8",
);

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
    expect(dev).toContain("--webpack");
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
    const hoistedPglite = pkg.dependencies?.["@electric-sql/pglite"];
    expect(hoistedPglite).toBeDefined();
    expect(pkg.overrides?.gbrain?.["@electric-sql/pglite"]).toBe(
      hoistedPglite,
    );
  });

  it("keeps optional HTTPS dev server support on explicit ScienceSwarm certificate paths", () => {
    expect(startScript).toContain("FRONTEND_HTTPS_KEY=\"$DATA_ROOT/certificates/localhost-key.pem\"");
    expect(startScript).toContain("FRONTEND_HTTPS_CERT=\"$DATA_ROOT/certificates/localhost.pem\"");
    expect(startScript).toContain("--experimental-https-key");
    expect(startScript).toContain("--experimental-https-cert");
    expect(startScript).toContain("openssl req -x509");
  });

  it("keeps installer setup output aligned with optional local HTTPS", () => {
    expect(installScript).toContain('FRONTEND_SCHEME="http"');
    expect(installScript).toContain("FRONTEND_USE_HTTPS");
    expect(installScript).toContain(
      "Manual setup URL: ${FRONTEND_SCHEME}://127.0.0.1:${FRONTEND_PORT}/setup",
    );
  });

  it("excludes downloaded local model blobs from desktop installer artifacts", () => {
    expect(pkg.build?.files).toEqual(
      expect.arrayContaining([
        "!desktop/ollama-models/**",
        "!desktop/**/*.gguf",
        "!desktop/**/blobs/**",
        "!desktop/**/manifests/**",
      ]),
    );
  });

  it("checks env-configured Ollama model names without regex interpolation", () => {
    expect(runtimePrereqsScript).toContain('MODEL="${MODEL#ollama/}"');
    expect(runtimePrereqsScript).toContain('awk -v target="$MODEL"');
    expect(runtimePrereqsScript).not.toContain('grep -Eq "^${MODEL}');
  });

  it("keeps shell Gemma alias matching aligned with TypeScript constants", () => {
    const aliasBlock = runtimePrereqsScript.match(
      /Keep the Gemma 4 alias rows in sync[\s\S]*?END \{ exit found \? 0 : 1 \}/,
    )?.[0] ?? "";

    expect(aliasBlock).not.toBe("");
    for (const alias of OLLAMA_RECOMMENDED_MODEL_ALIASES) {
      expect(aliasBlock).toContain(`"${alias}"`);
    }
  });
});
