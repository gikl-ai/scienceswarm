import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("brain write config surfaces", () => {
  it("declares SCIENCESWARM_USER_HANDLE in the OpenClaw plugin manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "openclaw.plugin.json"), "utf-8"),
    ) as {
      configSchema?: Record<string, { type?: string; required?: boolean }>;
    };

    expect(manifest.configSchema?.SCIENCESWARM_USER_HANDLE).toMatchObject({
      type: "string",
      required: true,
    });
  });

  it("documents SCIENCESWARM_USER_HANDLE in .env.example", () => {
    const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf-8");
    expect(envExample).toMatch(/^SCIENCESWARM_USER_HANDLE=/m);
  });
});
