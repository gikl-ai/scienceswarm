import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("gbrain runtime bridge import paths", () => {
  it("loads engine-factory through the gbrain package export", () => {
    const source = readFileSync(
      join(process.cwd(), "src/brain/stores/gbrain-runtime.mjs"),
      "utf8",
    );

    expect(source).toContain('import("gbrain/engine-factory")');
    expect(source).not.toContain(
      'import("../../../node_modules/gbrain/src/core/engine-factory.ts")',
    );
  });
});
