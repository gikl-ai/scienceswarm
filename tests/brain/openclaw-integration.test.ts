import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { initBrain } from "@/brain/init";
import {
  detectSetupIntent,
  getSetupSteps,
  createSetupState,
  processSetupResponse,
  completeSetup,
} from "@/brain/setup-flow";
import {
  enrichBriefingWithActions,
  handleBriefingAction,
  decodeAction,
} from "@/brain/briefing-actions";
import type { BrainConfig, MorningBrief } from "@/brain/types";
import type { LLMClient } from "@/brain/llm";

const TEST_ROOT = join(tmpdir(), "scienceswarm-brain-test-openclaw");
const BRAIN_ROOT = join(TEST_ROOT, "brain");

// ── Mock LLM ─────────────────────────────────────────

const mockLLM: LLMClient = {
  async complete() {
    return {
      content: "mock response",
      cost: {
        inputTokens: 10,
        outputTokens: 5,
        estimatedUsd: 0.001,
        model: "test-model",
      },
    };
  },
};

function makeConfig(): BrainConfig {
  return {
    root: BRAIN_ROOT,
    extractionModel: "test-model",
    synthesisModel: "test-model",
    rippleCap: 15,
    paperWatchBudget: 50,
    serendipityRate: 0.2,
  };
}

function makeMorningBrief(overrides?: Partial<MorningBrief>): MorningBrief {
  return {
    generatedAt: new Date().toISOString(),
    greeting: "Good morning.",
    topMatters: [
      {
        summary: "New CRISPR paper challenges off-target assumptions",
        whyItMatters: "Directly relevant to your primer design",
        evidence: ["wiki/entities/papers/zhang-2026.md"],
        urgency: "act-now" as const,
      },
    ],
    contradictions: [
      {
        claim1: {
          summary: "Off-target rate < 1%",
          source: "wiki/entities/papers/smith-2025.md",
          date: "2025-06-01",
        },
        claim2: {
          summary: "Off-target rate may exceed 5%",
          source: "wiki/entities/papers/zhang-2026.md",
          date: "2026-03-15",
        },
        implication: "Your current assay threshold may be too lenient",
      },
    ],
    frontier: [
      {
        title: "New base editor with reduced bystander mutations",
        source: "arxiv:2603.12345",
        relevanceScore: 0.85,
        whyItMatters: "Could replace current approach",
        threatOrOpportunity: "supports" as const,
      },
      {
        title: "Efficient guide RNA design for long targets",
        source: "doi:10.1234/abc",
        relevanceScore: 0.72,
        whyItMatters: "Addresses your sequence length constraint",
        threatOrOpportunity: "adjacent" as const,
      },
    ],
    staleThreads: [
      {
        name: "HeLa cell replication study",
        lastActivity: "2026-03-01",
        daysSinceActivity: 10,
        suggestedAction: "Review or archive",
      },
    ],
    openQuestions: [
      {
        question: "Does temperature affect Cas9 specificity?",
        project: "primer-design",
        firstAsked: "2026-03-20",
        daysPending: 5,
      },
    ],
    nextMove: {
      recommendation: "Run validation assay with updated off-target threshold",
      reasoning: "New contradictory evidence requires confirmation",
      assumptions: ["Lab access available this week"],
      missingEvidence: ["Independent replication of Zhang 2026"],
    },
    stats: {
      brainPages: 142,
      newPagesYesterday: 3,
      capturesYesterday: 5,
      enrichmentsYesterday: 2,
    },
    ...overrides,
  };
}

// ── Setup & Teardown ─────────────────────────────────

beforeEach(() => {
  vi.resetModules();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

afterEach(() => {
  vi.resetModules();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── Setup Flow: Intent Detection ─────────────────────

describe("detectSetupIntent", () => {
  it("detects 'set up my brain'", () => {
    expect(detectSetupIntent("set up my brain")).toBe(true);
  });

  it("detects 'set up my research brain'", () => {
    expect(detectSetupIntent("set up my research brain")).toBe(true);
  });

  it("detects 'create my research brain'", () => {
    expect(detectSetupIntent("create my research brain")).toBe(true);
  });

  it("detects 'initialize scienceswarm'", () => {
    expect(detectSetupIntent("initialize scienceswarm")).toBe(true);
  });

  it("detects 'get started'", () => {
    expect(detectSetupIntent("get started")).toBe(true);
  });

  it("detects 'brain setup'", () => {
    expect(detectSetupIntent("brain setup")).toBe(true);
  });

  it("detects 'new brain'", () => {
    expect(detectSetupIntent("new brain")).toBe(true);
  });

  it("rejects unrelated messages", () => {
    expect(detectSetupIntent("What is CRISPR?")).toBe(false);
    expect(detectSetupIntent("Show me my briefing")).toBe(false);
    expect(detectSetupIntent("hello")).toBe(false);
    expect(detectSetupIntent("")).toBe(false);
  });
});

// ── Setup Flow: Steps ────────────────────────────────

describe("getSetupSteps", () => {
  it("returns exactly 4 steps", () => {
    const steps = getSetupSteps();
    expect(steps).toHaveLength(4);
  });

  it("first step asks for name", () => {
    const steps = getSetupSteps();
    expect(steps[0].field).toBe("name");
    expect(steps[0].step).toBe(1);
    expect(steps[0].totalSteps).toBe(4);
    expect(steps[0].prompt).toContain("name");
  });

  it("second step asks for research field", () => {
    const steps = getSetupSteps();
    expect(steps[1].field).toBe("field");
    expect(steps[1].prompt).toContain("research field");
  });

  it("third step asks for institution (optional)", () => {
    const steps = getSetupSteps();
    expect(steps[2].field).toBe("institution");
    expect(steps[2].prompt).toContain("optional");
    expect(steps[2].default).toBe("");
  });

  it("fourth step asks for brain path with a default", () => {
    const steps = getSetupSteps();
    expect(steps[3].field).toBe("brainPath");
    expect(typeof steps[3].default).toBe("string");
    expect(steps[3].default!.length).toBeGreaterThan(0);
  });
});

// ── Setup Flow: Process Responses ────────────────────

describe("processSetupResponse", () => {
  it("advances from step 0 to step 1 after valid name", () => {
    const state = createSetupState();
    const result = processSetupResponse(state, "Dr. Ada Lovelace");

    expect(result.state.currentStep).toBe(1);
    expect(result.state.responses.name).toBe("Dr. Ada Lovelace");
    expect(result.nextStep).not.toBeNull();
    expect(result.nextStep!.field).toBe("field");
    expect(result.error).toBeUndefined();
  });

  it("rejects empty name with validation error", () => {
    const state = createSetupState();
    const result = processSetupResponse(state, "");

    expect(result.error).toBeDefined();
    expect(result.error).toContain("non-empty");
    expect(result.state.currentStep).toBe(0);
  });

  it("processes all 4 steps to completion", () => {
    let state = createSetupState();

    // Step 1: name
    let result = processSetupResponse(state, "Dr. Test");
    state = result.state;
    expect(state.currentStep).toBe(1);
    expect(state.completed).toBe(false);

    // Step 2: field
    result = processSetupResponse(state, "computational biology");
    state = result.state;
    expect(state.currentStep).toBe(2);
    expect(state.completed).toBe(false);

    // Step 3: institution (empty = use default)
    result = processSetupResponse(state, "");
    state = result.state;
    expect(state.currentStep).toBe(3);
    expect(state.responses.institution).toBe("");

    // Step 4: brain path
    result = processSetupResponse(state, BRAIN_ROOT);
    state = result.state;
    expect(state.currentStep).toBe(4);
    expect(state.completed).toBe(true);
    expect(result.nextStep).toBeNull();
  });

  it("uses default for brain path when empty", () => {
    let state = createSetupState();
    state = processSetupResponse(state, "Dr. Test").state;
    state = processSetupResponse(state, "biology").state;
    state = processSetupResponse(state, "").state;

    const result = processSetupResponse(state, "");
    expect(result.state.completed).toBe(true);
    // Should use the default path, which is a non-empty string
    expect(result.state.responses.brainPath.length).toBeGreaterThan(0);
  });
});

// ── Setup Flow: completeSetup ────────────────────────

describe("completeSetup", () => {
  it("creates brain directory with correct BRAIN.md", async () => {
    const state = {
      started: true,
      currentStep: 4,
      responses: {
        name: "Dr. Ada Lovelace",
        field: "mechanistic interpretability",
        institution: "Anthropic",
        brainPath: BRAIN_ROOT,
      },
      completed: true,
    };

    const result = await completeSetup(state);

    expect(result.brainPath).toBe(BRAIN_ROOT);
    expect(result.config.name).toBe("Dr. Ada Lovelace");
    expect(result.config.field).toBe("mechanistic interpretability");
    expect(result.config.institution).toBe("Anthropic");
    expect(result.message).toContain("ready");

    // Verify BRAIN.md was written with correct content
    const brainMd = readFileSync(join(BRAIN_ROOT, "BRAIN.md"), "utf-8");
    expect(brainMd).toContain("Dr. Ada Lovelace");
    expect(brainMd).toContain("mechanistic interpretability");
    expect(brainMd).toContain("Anthropic");

    // Verify directory structure was created
    expect(existsSync(join(BRAIN_ROOT, "raw/papers"))).toBe(true);
    expect(existsSync(join(BRAIN_ROOT, "wiki/projects"))).toBe(true);
    expect(existsSync(join(BRAIN_ROOT, "wiki/tasks"))).toBe(true);
    expect(existsSync(join(BRAIN_ROOT, "state/projects"))).toBe(true);
  });

  it("reports existing brain without overwriting", async () => {
    // Create a brain first
    initBrain({ root: BRAIN_ROOT, name: "Original" });

    const state = {
      started: true,
      currentStep: 4,
      responses: {
        name: "Overwriter",
        field: "biology",
        brainPath: BRAIN_ROOT,
      },
      completed: true,
    };

    const result = await completeSetup(state);
    expect(result.message).toContain("already exists");

    // Verify original content was not overwritten
    const brainMd = readFileSync(join(BRAIN_ROOT, "BRAIN.md"), "utf-8");
    expect(brainMd).toContain("Original");
    expect(brainMd).not.toContain("Overwriter");
  });
});

// ── Briefing Actions: enrichBriefingWithActions ──────

describe("enrichBriefingWithActions", () => {
  it("adds save-paper buttons for frontier items", () => {
    const brief = makeMorningBrief();
    const result = enrichBriefingWithActions(brief);

    expect(result.text).toContain("Morning Brief");
    const saveActions = result.actions.filter((a) =>
      a.label.startsWith("Save:"),
    );
    expect(saveActions.length).toBe(2); // 2 frontier items
  });

  it("adds create-task button for next move", () => {
    const brief = makeMorningBrief();
    const result = enrichBriefingWithActions(brief);

    const taskActions = result.actions.filter((a) =>
      a.label.startsWith("Create task"),
    );
    expect(taskActions.length).toBe(1);
  });

  it("adds show-evidence button for contradictions", () => {
    const brief = makeMorningBrief();
    const result = enrichBriefingWithActions(brief);

    const evidenceActions = result.actions.filter((a) =>
      a.label.startsWith("Evidence:"),
    );
    expect(evidenceActions.length).toBe(1); // 1 contradiction
  });

  it("adds archive button for stale threads", () => {
    const brief = makeMorningBrief();
    const result = enrichBriefingWithActions(brief);

    const archiveActions = result.actions.filter((a) =>
      a.label.startsWith("Archive:"),
    );
    expect(archiveActions.length).toBe(1); // 1 stale thread
  });

  it("handles empty brief without crashing", () => {
    const brief = makeMorningBrief({
      frontier: [],
      contradictions: [],
      staleThreads: [],
      nextMove: {
        recommendation: "",
        reasoning: "",
        assumptions: [],
        missingEvidence: [],
      },
    });
    const result = enrichBriefingWithActions(brief);

    expect(result.text).toContain("Morning Brief");
    // No frontier + no nextMove recommendation + no contradictions + no stale
    expect(result.actions).toHaveLength(0);
  });
});

// ── Briefing Actions: callback_data fits in 64 bytes ─

describe("callback_data size", () => {
  it("all callback_data values fit within 64 bytes", () => {
    const brief = makeMorningBrief();
    const result = enrichBriefingWithActions(brief);

    for (const action of result.actions) {
      const byteLength = Buffer.byteLength(action.callbackData, "utf-8");
      expect(byteLength).toBeLessThanOrEqual(64);
    }
  });

  it("long titles get truncated to stay within 64 bytes", () => {
    const brief = makeMorningBrief({
      frontier: [
        {
          title:
            "A very long paper title that exceeds normal limits and should be truncated to fit Telegram requirements",
          source: "arxiv:2603.99999",
          relevanceScore: 0.9,
          whyItMatters: "Testing truncation",
          threatOrOpportunity: "supports" as const,
        },
      ],
    });
    const result = enrichBriefingWithActions(brief);

    for (const action of result.actions) {
      const byteLength = Buffer.byteLength(action.callbackData, "utf-8");
      expect(byteLength).toBeLessThanOrEqual(64);
    }
  });
});

// ── Briefing Actions: decodeAction ───────────────────

describe("decodeAction", () => {
  it("roundtrips save-paper action", () => {
    const brief = makeMorningBrief();
    const result = enrichBriefingWithActions(brief);
    const saveAction = result.actions.find((a) => a.label.startsWith("Save:"));
    expect(saveAction).toBeDefined();

    const decoded = decodeAction(saveAction!.callbackData);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe("save-paper");
  });

  it("roundtrips create-task action", () => {
    const brief = makeMorningBrief();
    const result = enrichBriefingWithActions(brief);
    const taskAction = result.actions.find((a) =>
      a.label.startsWith("Create task"),
    );
    expect(taskAction).toBeDefined();

    const decoded = decodeAction(taskAction!.callbackData);
    expect(decoded).not.toBeNull();
    expect(decoded!.type).toBe("create-task");
  });

  it("returns null for invalid JSON", () => {
    expect(decodeAction("not-json")).toBeNull();
  });

  it("returns null for unknown type", () => {
    expect(decodeAction('{"t":"xx"}')).toBeNull();
  });
});

// ── Briefing Actions: handleBriefingAction ───────────

describe("handleBriefingAction", () => {
  const config = makeConfig();

  beforeEach(() => {
    initBrain({ root: BRAIN_ROOT, name: "Test Researcher" });
  });

  it("save-paper creates a wiki page with correct frontmatter", async () => {
    const message = await handleBriefingAction(config, mockLLM, {
      type: "save-paper",
      title: "CRISPR Off-Target Analysis",
      arxivId: "2603.12345",
    });

    expect(message).toContain("Paper saved");
    expect(message).toContain("CRISPR Off-Target Analysis");

    // Read back the file to verify content
    const slug = "crispr-off-target-analysis";
    const filePath = join(BRAIN_ROOT, "wiki/entities/papers", `${slug}.md`);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain('title: "CRISPR Off-Target Analysis"');
    expect(content).toContain("type: paper");
    expect(content).toContain('arxiv: "2603.12345"');
    expect(content).toContain("saved-from-briefing");
  });

  it("create-task creates a task wiki page", async () => {
    const message = await handleBriefingAction(config, mockLLM, {
      type: "create-task",
      title: "Run validation assay",
      project: "primer-design",
    });

    expect(message).toContain("Task created");
    expect(message).toContain("Run validation assay");

    const slug = "run-validation-assay";
    const filePath = join(BRAIN_ROOT, "wiki/tasks", `${slug}.md`);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain('title: "Run validation assay"');
    expect(content).toContain("type: task");
    expect(content).toContain("status: open");
    expect(content).toContain('study: "primer-design"');
    expect(content).toContain('study_slug: "primer-design"');
    expect(content).toContain("from-briefing");
  });

  it("show-evidence returns search results or no-results message", async () => {
    const message = await handleBriefingAction(config, mockLLM, {
      type: "show-evidence",
      page: "wiki/entities/papers/smith-2025.md",
    });

    // Either finds evidence or reports none found
    expect(
      message.includes("Evidence for:") || message.includes("No evidence found"),
    ).toBe(true);
  });

  it("dismiss-item writes to dismissed-items.jsonl", async () => {
    const message = await handleBriefingAction(config, mockLLM, {
      type: "dismiss-item",
      itemId: "HeLa-replication",
    });

    expect(message).toBe("Dismissed: HeLa-replication");

    const dismissalsPath = join(BRAIN_ROOT, "state/dismissed-items.jsonl");
    expect(existsSync(dismissalsPath)).toBe(true);

    const content = readFileSync(dismissalsPath, "utf-8");
    const entry = JSON.parse(content.trim());
    expect(entry.itemId).toBe("HeLa-replication");
    expect(entry.dismissedAt).toBeDefined();
  });

  it("ingest-paper creates raw placeholder file", async () => {
    const message = await handleBriefingAction(config, mockLLM, {
      type: "ingest-paper",
      source: "https://arxiv.org/abs/2603.12345",
    });

    expect(message).toContain("queued for ingestion");

    // Check file was created in raw/papers
    const files = readdirSync(join(BRAIN_ROOT, "raw/papers"));
    const ingestFile = files.find(
      (f: string) => f.includes("arxiv") && f.endsWith(".md"),
    );
    expect(ingestFile).toBeDefined();

    const content = readFileSync(
      join(BRAIN_ROOT, "raw/papers", ingestFile!),
      "utf-8",
    );
    expect(content).toContain("https://arxiv.org/abs/2603.12345");
    expect(content).toContain("ingested-from-briefing");
  });
});

// ── API Routes: Setup ────────────────────────────────

describe("POST /api/brain/setup", () => {
  // Import the actual route handler
  const setupRoute = async () => {
    const mod = await import("@/app/api/brain/setup/route");
    return mod.POST;
  };

  it("start action returns first setup step", async () => {
    const POST = await setupRoute();
    const request = new Request("http://localhost/api/brain/setup", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.step).toBeDefined();
    expect(data.step.step).toBe(1);
    expect(data.step.field).toBe("name");
    expect(data.state.started).toBe(true);
    expect(data.state.currentStep).toBe(0);
  });

  it("respond action advances to next step", async () => {
    const POST = await setupRoute();
    const request = new Request("http://localhost/api/brain/setup", {
      method: "POST",
      body: JSON.stringify({
        action: "respond",
        step: 0,
        response: "Dr. Test",
        state: { responses: {} },
      }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.step).toBeDefined();
    expect(data.step.field).toBe("field");
    expect(data.state.responses.name).toBe("Dr. Test");
  });

  it("complete action creates brain and returns result", async () => {
    const POST = await setupRoute();
    const request = new Request("http://localhost/api/brain/setup", {
      method: "POST",
      body: JSON.stringify({
        action: "complete",
        responses: {
          name: "Dr. Test",
          field: "biology",
          institution: "MIT",
          brainPath: join(TEST_ROOT, "complete-brain"),
        },
      }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.completed).toBe(true);
    expect(data.result.brainPath).toBe(join(TEST_ROOT, "complete-brain"));
    expect(data.result.config.name).toBe("Dr. Test");
    expect(data.result.config.field).toBe("biology");
    expect(data.result.message).toContain("ready");

    // Verify brain was actually created
    expect(existsSync(join(TEST_ROOT, "complete-brain", "BRAIN.md"))).toBe(true);
  });

  it("rejects invalid JSON", async () => {
    const POST = await setupRoute();
    const request = new Request("http://localhost/api/brain/setup", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Invalid JSON");
  });

  it("rejects unknown action", async () => {
    const POST = await setupRoute();
    const request = new Request("http://localhost/api/brain/setup", {
      method: "POST",
      body: JSON.stringify({ action: "foobar" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Unknown action");
  });
});

// ── API Routes: Briefing Action ──────────────────────

describe("POST /api/brain/briefing-action", () => {
  const briefingActionRoute = async () => {
    const mod = await import("@/app/api/brain/briefing-action/route");
    return mod.POST;
  };

  it("rejects invalid JSON body", async () => {
    const POST = await briefingActionRoute();
    const request = new Request(
      "http://localhost/api/brain/briefing-action",
      {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid JSON");
  });

  it("rejects missing action", async () => {
    const POST = await briefingActionRoute();
    const request = new Request(
      "http://localhost/api/brain/briefing-action",
      {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain("Invalid or missing action");
  });

  it("rejects action with invalid type", async () => {
    const POST = await briefingActionRoute();
    const request = new Request(
      "http://localhost/api/brain/briefing-action",
      {
        method: "POST",
        body: JSON.stringify({ action: { type: "nope" } }),
        headers: { "Content-Type": "application/json" },
      },
    );

    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});
