import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("background import job import boundary", () => {
  it("imports the lightweight current-user handle helper instead of the installer", async () => {
    const source = await readFile(
      new URL("../../src/lib/import/background-import-job.ts", import.meta.url),
      "utf-8",
    );

    expect(source).toContain('from "@/lib/setup/current-user-handle"');
    expect(source).not.toContain('from "@/lib/setup/gbrain-installer"');
  });
});
