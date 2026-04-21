import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { resolveBrainFile } from "@/brain/template-paths";

describe("resolveBrainFile", () => {
  it("warns before falling back to a missing path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const missingLeaf = `missing-${randomUUID()}.md`;

    const resolved = resolveBrainFile("__missing__", missingLeaf);

    expect(resolved).toContain(path.join("__missing__", missingLeaf));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(missingLeaf),
    );
    warn.mockRestore();
  });
});
