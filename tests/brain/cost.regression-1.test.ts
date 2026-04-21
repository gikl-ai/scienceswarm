import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logEvent } from "@/brain/cost";
import type { BrainConfig } from "@/brain/types";

describe("cost event logging regressions", () => {
  it("creates the legacy event log directory for gbrain-first roots", () => {
    // Regression: ISSUE-002 - manual Dream Cycle failed when a PGLite-only
    // brain root had no wiki/events.jsonl file yet.
    // Found by /qa on 2026-04-18.
    // Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-04-18.md
    const root = mkdtempSync(join(tmpdir(), "scienceswarm-cost-regression-"));
    const config: BrainConfig = {
      root,
      extractionModel: "test",
      synthesisModel: "test",
      rippleCap: 15,
      paperWatchBudget: 50,
      serendipityRate: 0.2,
    };

    try {
      logEvent(config, {
        ts: "2026-04-18T16:00:00.000Z",
        type: "compile",
      });

      const eventLog = readFileSync(join(root, "wiki/events.jsonl"), "utf-8");
      expect(JSON.parse(eventLog.trim())).toMatchObject({ type: "compile" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

