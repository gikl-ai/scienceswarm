import { isCaptureKind } from "@/brain/types";
import type { CaptureClassification } from "./types";

const TASK_PATTERNS = [
  /\b(todo|to do|follow up|follow-up|remind|reminder|action item)\b/i,
  /\bneed to\b/i,
  /\bshould\b/i,
  /\bnext step\b/i,
];

const DECISION_PATTERNS = [
  /\bdecision\b/i,
  /\bdecided\b/i,
  /\bwe will\b/i,
  /\blet'?s\b/i,
];

const HYPOTHESIS_PATTERNS = [
  /\bhypothesis\b/i,
  /\bmaybe\b/i,
  /\bmight\b/i,
  /\bcould\b/i,
  /\bpossibly\b/i,
];

const OBSERVATION_PATTERNS = [
  /\bobserved\b/i,
  /\bresult\b/i,
  /\bmeasurement\b/i,
  /\bfound\b/i,
  /\bsaw\b/i,
];

export function classifyCapture(content: string, explicitKind?: string): CaptureClassification {
  if (isCaptureKind(explicitKind)) {
    return {
      kind: explicitKind,
      confidence: "high",
      needsClarification: false,
    };
  }

  const text = content.trim();

  if (TASK_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "task", confidence: "medium", needsClarification: false };
  }

  if (DECISION_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "decision", confidence: "medium", needsClarification: false };
  }

  if (HYPOTHESIS_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "hypothesis", confidence: "medium", needsClarification: false };
  }

  if (OBSERVATION_PATTERNS.some((pattern) => pattern.test(text))) {
    return { kind: "observation", confidence: "medium", needsClarification: false };
  }

  return { kind: "note", confidence: "low", needsClarification: false };
}
