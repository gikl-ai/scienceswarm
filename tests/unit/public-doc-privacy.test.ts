import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const FORBIDDEN_PUBLIC_DOCS = [
  "docs/chat-speed-openclaw-tui-plan.md",
] as const;

describe("public docs privacy guard", () => {
  it("keeps private planning docs out of tracked public docs paths", () => {
    for (const relativePath of FORBIDDEN_PUBLIC_DOCS) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, relativePath)),
        `${relativePath} should stay local-only and never ship in the public repository`,
      ).toBe(false);
    }
  });
});
