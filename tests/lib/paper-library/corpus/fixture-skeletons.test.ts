import { describe, expect, it } from "vitest";

import {
  requiredPhase0CorpusFixtureKinds,
  validateCorpusFixtureDescriptors,
} from "./fixture-helpers";
import { phase0CorpusFixtureDescriptors } from "../../../fixtures/paper-library/corpus/phase0-fixtures";

describe("paper-library corpus fixture skeletons", () => {
  it("covers every first-train source and failure fixture class", () => {
    const parsed = validateCorpusFixtureDescriptors(phase0CorpusFixtureDescriptors);
    expect(parsed.map((descriptor) => descriptor.kind).sort()).toEqual(
      [...requiredPhase0CorpusFixtureKinds].sort(),
    );
  });

  it("rejects a skeleton set that omits a required parser or duplicate path", () => {
    const withoutPdfFailure = phase0CorpusFixtureDescriptors.filter(
      (descriptor) => descriptor.kind !== "advanced_pdf_parser_unavailable",
    );

    expect(() => validateCorpusFixtureDescriptors(withoutPdfFailure)).toThrow(
      /advanced_pdf_parser_unavailable/,
    );
  });

  it("rejects fixture warning codes outside the corpus warning contract", () => {
    const descriptorsWithInvalidWarning = phase0CorpusFixtureDescriptors.map((descriptor) =>
      descriptor.kind === "advanced_pdf_parser_unavailable"
        ? { ...descriptor, expectedWarnings: ["parser_unavaialble"] }
        : descriptor,
    );

    expect(() => validateCorpusFixtureDescriptors(descriptorsWithInvalidWarning)).toThrow(
      /Invalid enum value/,
    );
  });
});
