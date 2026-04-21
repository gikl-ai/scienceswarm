/**
 * Second Brain — Natural Language Setup Flow
 *
 * Guides a new user through brain creation via conversational steps.
 * Designed for use via Telegram/OpenClaw: the user says "set up my
 * research brain" and the system walks them through 4 questions.
 */

import { initBrain } from "./init";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";

// ── Types ────────────────────────────────────────────

export interface SetupStep {
  step: number;
  totalSteps: number;
  prompt: string;
  field: string;
  default?: string;
  validation?: (input: string) => string | null;
}

export interface SetupState {
  started: boolean;
  currentStep: number;
  responses: Record<string, string>;
  completed: boolean;
  brainPath?: string;
}

export interface SetupResult {
  brainPath: string;
  config: {
    name: string;
    field: string;
    institution?: string;
    extractionModel: string;
    synthesisModel: string;
  };
  message: string;
}

// ── Intent Detection ─────────────────────────────────

const SETUP_PATTERNS = [
  /set\s*up\s*(my\s+)?(research\s+)?brain/i,
  /create\s*(my\s+)?(research\s+)?brain/i,
  /init(ialize)?\s*(my\s+)?(research\s+)?brain/i,
  /initialize\s+scienceswarm/i,
  /init\s+scienceswarm/i,
  /get\s+started/i,
  /start\s+(my\s+)?brain/i,
  /new\s+brain/i,
  /brain\s+setup/i,
];

/**
 * Detect whether a message is asking to set up a brain.
 */
export function detectSetupIntent(message: string): boolean {
  const trimmed = message.trim();
  return SETUP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// ── Setup Steps ──────────────────────────────────────

const TOTAL_STEPS = 4;

function validateNonEmpty(input: string): string | null {
  if (!input.trim()) return "Please provide a non-empty answer.";
  return null;
}

function validateField(input: string): string | null {
  if (!input.trim()) return "Please describe your research field (e.g., computational biology).";
  return null;
}

/**
 * Return the full setup conversation flow (4 steps).
 */
export function getSetupSteps(): SetupStep[] {
  return [
    {
      step: 1,
      totalSteps: TOTAL_STEPS,
      prompt: "What's your name?",
      field: "name",
      validation: validateNonEmpty,
    },
    {
      step: 2,
      totalSteps: TOTAL_STEPS,
      prompt:
        'What\'s your research field? (e.g., "computational biology", "mechanistic interpretability")',
      field: "field",
      validation: validateField,
    },
    {
      step: 3,
      totalSteps: TOTAL_STEPS,
      prompt: "What institution are you at? (optional -- press enter to skip)",
      field: "institution",
      default: "",
    },
    {
      step: 4,
      totalSteps: TOTAL_STEPS,
      prompt: "Where should I create your brain?",
      field: "brainPath",
      default: getDefaultBrainPath(),
    },
  ];
}

function getDefaultBrainPath(): string {
  return getScienceSwarmBrainRoot();
}

// ── State Machine ────────────────────────────────────

/**
 * Create initial setup state.
 */
export function createSetupState(): SetupState {
  return {
    started: true,
    currentStep: 0,
    responses: {},
    completed: false,
  };
}

/**
 * Process one user response and advance to the next step.
 * Returns the next step to present, or null if all steps are done.
 */
export function processSetupResponse(
  state: SetupState,
  response: string,
): { nextStep: SetupStep | null; state: SetupState; error?: string } {
  const steps = getSetupSteps();
  const currentStepDef = steps[state.currentStep];
  if (!currentStepDef) {
    return {
      nextStep: null,
      state: { ...state, completed: true },
    };
  }

  // Use default if response is empty and a default exists
  const effectiveResponse =
    response.trim() || currentStepDef.default || "";

  // Validate
  if (currentStepDef.validation) {
    const error = currentStepDef.validation(effectiveResponse);
    if (error) {
      return {
        nextStep: currentStepDef,
        state,
        error,
      };
    }
  }

  // Record response and advance
  const newResponses = {
    ...state.responses,
    [currentStepDef.field]: effectiveResponse,
  };
  const nextStepIndex = state.currentStep + 1;
  const isComplete = nextStepIndex >= steps.length;

  const newState: SetupState = {
    ...state,
    currentStep: nextStepIndex,
    responses: newResponses,
    completed: isComplete,
  };

  const nextStep = isComplete ? null : steps[nextStepIndex];
  return { nextStep, state: newState };
}

// ── Completion ───────────────────────────────────────

/**
 * Create the brain directory and write personalized BRAIN.md.
 * Returns the result with confirmation message.
 */
export async function completeSetup(
  state: SetupState,
): Promise<SetupResult> {
  const name = state.responses.name ?? "";
  const field = state.responses.field ?? "";
  const institution = state.responses.institution || undefined;
  const brainPath =
    state.responses.brainPath?.trim() || getDefaultBrainPath();

  const result = initBrain({
    root: brainPath,
    name,
    field,
    institution,
  });

  const configSummary = {
    name,
    field,
    institution,
    extractionModel: "gpt-4.1-mini",
    synthesisModel: "gpt-4.1",
  };

  const message = result.created
    ? [
        `Your research brain is ready at ${brainPath}.`,
        "",
        `Name: ${name}`,
        `Field: ${field}`,
        institution ? `Institution: ${institution}` : "",
        "",
        "You can now:",
        "- Send papers or notes to capture them",
        "- Ask for a morning briefing",
        "- Search your brain with natural language",
      ]
        .filter(Boolean)
        .join("\n")
    : `Brain already exists at ${brainPath}. No changes made.`;

  return {
    brainPath,
    config: configSummary,
    message,
  };
}
