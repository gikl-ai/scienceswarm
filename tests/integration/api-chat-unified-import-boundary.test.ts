import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("api chat unified import boundary", () => {
  it("lazy-loads the brain store instead of importing it at route module scope", async () => {
    const routeSource = await readFile(
      new URL("../../src/app/api/chat/unified/route.ts", import.meta.url),
      "utf-8",
    );

    expect(routeSource).toContain('await import("@/brain/store")');
    expect(routeSource).toContain("async function loadReadyBrainStore()");
    expect(routeSource).not.toContain('import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";');
  });

  it("imports the lightweight current-user handle helper instead of the installer", async () => {
    const routeSource = await readFile(
      new URL("../../src/app/api/chat/unified/route.ts", import.meta.url),
      "utf-8",
    );

    expect(routeSource).toContain('from "@/lib/setup/current-user-handle"');
    expect(routeSource).not.toContain('from "@/lib/setup/gbrain-installer"');
  });
});
