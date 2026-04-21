import { describe, expect, it } from "vitest";

import {
  HOSTED_DESCARTES_RECOVERY_MESSAGE,
  STRUCTURED_CRITIQUE_INTERNAL_PIPELINE_ERROR,
  getStructuredCritiqueDisplayError,
} from "@/lib/structured-critique-errors";

describe("getStructuredCritiqueDisplayError", () => {
  it("keeps specific upstream messages intact", () => {
    expect(getStructuredCritiqueDisplayError("PDF is encrypted")).toBe(
      "PDF is encrypted",
    );
  });

  it("maps the generic internal pipeline failure to hosted Descartes guidance", () => {
    expect(
      getStructuredCritiqueDisplayError(
        STRUCTURED_CRITIQUE_INTERNAL_PIPELINE_ERROR,
      ),
    ).toBe(HOSTED_DESCARTES_RECOVERY_MESSAGE);
  });

  it("falls back when no upstream message is present", () => {
    expect(getStructuredCritiqueDisplayError(null)).toBe(
      "The critique run failed.",
    );
  });
});
