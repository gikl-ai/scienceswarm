import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globSync } from "glob";

describe("database skill gbrain boundary", () => {
  it("never instantiates the subprocess gbrain client", () => {
    const files = globSync("src/lib/skills/db-*.ts", { cwd: process.cwd() });
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf-8");
      expect(source).not.toContain("createGbrainClient");
      expect(source).not.toContain("from \"@/brain/gbrain-client\"");
      expect(source).not.toContain("from \"../../brain/gbrain-client\"");
    }
  });
});
