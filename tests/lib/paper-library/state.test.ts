import { describe, expect, it } from "vitest";
import {
  getPaperLibraryApplyPlanPath,
  getPaperLibraryReviewShardPath,
  getPaperLibraryScanPath,
  parsePersistedState,
  readCursorWindow,
} from "@/lib/paper-library/state";
import { PaperLibraryScanSchema } from "@/lib/paper-library/contracts";

describe("paper-library state", () => {
  it("builds project-scoped state paths", () => {
    expect(getPaperLibraryScanPath("project-alpha", "scan/1", "/tmp/state")).toBe(
      "/tmp/state/projects/project-alpha/paper-library/scans/scan%2F1.json",
    );
    expect(getPaperLibraryReviewShardPath("project-alpha", "scan-1", "0001", "/tmp/state")).toBe(
      "/tmp/state/projects/project-alpha/paper-library/reviews/scan-1/0001.json",
    );
    expect(getPaperLibraryApplyPlanPath("project-alpha", "plan-1", "/tmp/state")).toBe(
      "/tmp/state/projects/project-alpha/paper-library/apply-plans/plan-1.json",
    );
  });

  it("returns repairable state for malformed persisted JSON", () => {
    const parsed = parsePersistedState(
      { version: 1, id: "scan-1", project: "../bad" },
      PaperLibraryScanSchema,
      { kind: "scan", path: "/tmp/scan.json" },
    );

    expect(parsed).toMatchObject({
      ok: false,
      repairable: {
        code: "malformed",
        path: "/tmp/scan.json",
      },
    });
  });

  it("returns repairable state for unsupported versions", () => {
    const parsed = parsePersistedState(
      { version: 999, id: "scan-1" },
      PaperLibraryScanSchema,
      { kind: "scan" },
    );

    expect(parsed).toMatchObject({
      ok: false,
      repairable: {
        code: "unsupported_version",
      },
    });
  });

  it("paginates cursor windows with bounded limits", () => {
    const first = readCursorWindow(["a", "b", "c"], { limit: 2 });
    expect(first).toMatchObject({
      items: ["a", "b"],
      totalCount: 3,
      filteredCount: 3,
    });
    expect(first.nextCursor).toBeDefined();

    const second = readCursorWindow(["a", "b", "c"], { cursor: first.nextCursor, limit: 2 });
    expect(second.items).toEqual(["c"]);
    expect(second.nextCursor).toBeUndefined();
  });
});

