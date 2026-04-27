import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("brain readiness import boundaries", () => {
  it("keeps the heavy engine probe out of the cheap readiness helper module", async () => {
    const readinessSource = await readFile(
      new URL("../../src/lib/brain/readiness.ts", import.meta.url),
      "utf-8",
    );
    const engineReadinessSource = await readFile(
      new URL("../../src/lib/brain/engine-readiness.ts", import.meta.url),
      "utf-8",
    );
    const healthRouteSource = await readFile(
      new URL("../../src/app/api/health/route.ts", import.meta.url),
      "utf-8",
    );

    expect(readinessSource).not.toContain('await import("@/brain/store")');
    expect(engineReadinessSource).toContain('await import("@/brain/store")');
    expect(healthRouteSource).toContain('from "@/lib/brain/engine-readiness"');
  });
});
