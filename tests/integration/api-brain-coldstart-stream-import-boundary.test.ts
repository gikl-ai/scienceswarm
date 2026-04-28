import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("api brain coldstart-stream import boundary", () => {
  it("imports the lightweight current-user handle helper instead of the installer", async () => {
    const routeSource = await readFile(
      new URL("../../src/app/api/brain/coldstart-stream/route.ts", import.meta.url),
      "utf-8",
    );

    expect(routeSource).toContain('from "@/lib/setup/current-user-handle"');
    expect(routeSource).not.toContain('from "@/lib/setup/gbrain-installer"');
  });
});
