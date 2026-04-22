import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStructuredCritiqueFeedbackDir } from "@/lib/structured-critique-feedback";

const ORIGINAL_BRAIN_ROOT = process.env.BRAIN_ROOT;
const ORIGINAL_FEEDBACK_DIR = process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR;
const ORIGINAL_SCIENCESWARM_DIR = process.env.SCIENCESWARM_DIR;

afterEach(() => {
  restoreEnv("BRAIN_ROOT", ORIGINAL_BRAIN_ROOT);
  restoreEnv("STRUCTURED_CRITIQUE_FEEDBACK_DIR", ORIGINAL_FEEDBACK_DIR);
  restoreEnv("SCIENCESWARM_DIR", ORIGINAL_SCIENCESWARM_DIR);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("getStructuredCritiqueFeedbackDir", () => {
  it("stores feedback under gbrain state by default", () => {
    delete process.env.BRAIN_ROOT;
    delete process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR;
    process.env.SCIENCESWARM_DIR = "/tmp/scienceswarm-feedback";

    expect(getStructuredCritiqueFeedbackDir()).toBe(
      path.join("/tmp/scienceswarm-feedback", "brain", "state", "feedback"),
    );
  });

  it("preserves explicit feedback directory overrides", () => {
    process.env.STRUCTURED_CRITIQUE_FEEDBACK_DIR = "/tmp/feedback-override";

    expect(getStructuredCritiqueFeedbackDir()).toBe("/tmp/feedback-override");
  });
});
