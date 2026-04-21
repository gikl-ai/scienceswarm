import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { aggregateCosts, getMonthCost, logEvent, getRecentEvents, isBudgetExceeded } from "@/brain/cost";
import { initBrain } from "@/brain/init";
import type { BrainConfig, IngestCost, BrainEvent } from "@/brain/types";

const TEST_ROOT = join(tmpdir(), "scienceswarm-brain-test-cost");

function makeConfig(budget = 50): BrainConfig {
  return {
    root: TEST_ROOT,
    extractionModel: "test",
    synthesisModel: "test",
    rippleCap: 15,
    paperWatchBudget: budget,
    serendipityRate: 0.2,
  };
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  initBrain({ root: TEST_ROOT });
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("aggregateCosts", () => {
  it("sums token counts and costs", () => {
    const costs: IngestCost[] = [
      { inputTokens: 100, outputTokens: 50, estimatedUsd: 0.01, model: "a" },
      { inputTokens: 200, outputTokens: 100, estimatedUsd: 0.02, model: "b" },
    ];
    const total = aggregateCosts(costs);
    expect(total.inputTokens).toBe(300);
    expect(total.outputTokens).toBe(150);
    expect(total.estimatedUsd).toBe(0.03);
    expect(total.model).toBe("mixed");
  });

  it("uses single model name when only one model", () => {
    const costs: IngestCost[] = [
      { inputTokens: 100, outputTokens: 50, estimatedUsd: 0.01, model: "gpt-4.1-mini" },
    ];
    const total = aggregateCosts(costs);
    expect(total.model).toBe("gpt-4.1-mini");
  });
});

describe("logEvent + getRecentEvents", () => {
  it("appends events to events.jsonl", () => {
    const config = makeConfig();
    const event: BrainEvent = {
      ts: new Date().toISOString(),
      type: "ingest",
      contentType: "paper",
      created: ["wiki/entities/papers/test.md"],
      cost: { inputTokens: 500, outputTokens: 200, estimatedUsd: 0.05, model: "test" },
    };

    logEvent(config, event);

    const content = readFileSync(join(TEST_ROOT, "wiki/events.jsonl"), "utf-8");
    expect(content.trim()).not.toBe("");
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe("ingest");
  });

  it("retrieves recent events", () => {
    const config = makeConfig();

    for (let i = 0; i < 5; i++) {
      logEvent(config, {
        ts: new Date(Date.now() - i * 60000).toISOString(),
        type: "ingest",
        contentType: "paper",
      });
    }

    const events = getRecentEvents(config, undefined, 3);
    expect(events.length).toBe(3);
  });
});

describe("getMonthCost", () => {
  it("sums costs for the current month", () => {
    const config = makeConfig();
    const now = new Date();

    logEvent(config, {
      ts: now.toISOString(),
      type: "ingest",
      cost: { inputTokens: 100, outputTokens: 50, estimatedUsd: 0.10, model: "test" },
    });
    logEvent(config, {
      ts: now.toISOString(),
      type: "ingest",
      cost: { inputTokens: 200, outputTokens: 100, estimatedUsd: 0.25, model: "test" },
    });

    expect(getMonthCost(config)).toBe(0.35);
  });

  it("returns 0 for empty events", () => {
    expect(getMonthCost(makeConfig())).toBe(0);
  });
});

describe("isBudgetExceeded", () => {
  it("returns false when under budget", () => {
    const config = makeConfig(50);
    logEvent(config, {
      ts: new Date().toISOString(),
      type: "ingest",
      cost: { inputTokens: 100, outputTokens: 50, estimatedUsd: 10, model: "test" },
    });
    expect(isBudgetExceeded(config)).toBe(false);
  });

  it("returns true when at or over budget", () => {
    const config = makeConfig(1);
    logEvent(config, {
      ts: new Date().toISOString(),
      type: "ingest",
      cost: { inputTokens: 100, outputTokens: 50, estimatedUsd: 1.5, model: "test" },
    });
    expect(isBudgetExceeded(config)).toBe(true);
  });
});
