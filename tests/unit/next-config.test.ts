import { describe, expect, it } from "vitest";

import nextConfig, { resolveBuildOutput } from "../../next.config";

describe("next.config", () => {
  it("keeps PGLite external so server init can load extension tarballs from disk", () => {
    expect(nextConfig.serverExternalPackages).toContain("@electric-sql/pglite");
  });

  it("prefers static export for capacitor builds", () => {
    expect(resolveBuildOutput({ CAPACITOR_BUILD: "1" })).toBe("export");
  });

  it("enables standalone output for desktop packaging builds", () => {
    expect(resolveBuildOutput({ SCIENCESWARM_STANDALONE_BUILD: "1" })).toBe("standalone");
  });

  it("leaves output unchanged for the default web app build", () => {
    expect(resolveBuildOutput({})).toBeUndefined();
  });

  it("keeps capacitor export precedence over standalone desktop packaging", () => {
    expect(
      resolveBuildOutput({
        CAPACITOR_BUILD: "1",
        SCIENCESWARM_STANDALONE_BUILD: "1",
      }),
    ).toBe("export");
  });
});
