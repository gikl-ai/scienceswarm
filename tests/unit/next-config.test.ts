import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

describe("next.config", () => {
  it("keeps PGLite external so server init can load extension tarballs from disk", () => {
    expect(nextConfig.serverExternalPackages).toContain("@electric-sql/pglite");
  });
});
