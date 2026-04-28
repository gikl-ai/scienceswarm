import { z } from "zod";

import {
  BibliographyEntryArtifactSchema,
  PaperIngestManifestSchema,
  PaperSectionMapSchema,
  PaperSourceArtifactSchema,
  PaperSourceCandidateSchema,
  PaperSummaryArtifactSchema,
} from "./contracts";

export const CorpusFixtureKindSchema = z.enum([
  "arxiv_latex_source",
  "local_latex_or_html_sidecar",
  "good_text_layer_pdf",
  "advanced_pdf_parser_unavailable",
  "scanned_or_low_text_pdf",
  "duplicate_identity",
]);
export type CorpusFixtureKind = z.infer<typeof CorpusFixtureKindSchema>;

export const CorpusFixtureDescriptorSchema = z.object({
  kind: CorpusFixtureKindSchema,
  paperId: z.string().min(1),
  paperSlug: z.string().min(1),
  description: z.string().min(1),
  expectedCandidate: PaperSourceCandidateSchema,
  expectedSourceArtifact: PaperSourceArtifactSchema.optional(),
  expectedSectionMap: PaperSectionMapSchema.optional(),
  expectedRelevanceSummary: PaperSummaryArtifactSchema.optional(),
  expectedBibliography: z.array(BibliographyEntryArtifactSchema).default([]),
  expectedManifest: PaperIngestManifestSchema.optional(),
  expectedWarnings: z.array(z.string().min(1)).default([]),
});
export type CorpusFixtureDescriptor = z.input<typeof CorpusFixtureDescriptorSchema>;
export type ParsedCorpusFixtureDescriptor = z.infer<typeof CorpusFixtureDescriptorSchema>;

export const requiredPhase0CorpusFixtureKinds = [
  "arxiv_latex_source",
  "local_latex_or_html_sidecar",
  "good_text_layer_pdf",
  "advanced_pdf_parser_unavailable",
  "scanned_or_low_text_pdf",
  "duplicate_identity",
] as const satisfies readonly CorpusFixtureKind[];

export function validateCorpusFixtureDescriptors(
  descriptors: unknown[],
): ParsedCorpusFixtureDescriptor[] {
  const parsed = z.array(CorpusFixtureDescriptorSchema).parse(descriptors);
  const availableKinds = new Set(parsed.map((descriptor) => descriptor.kind));
  const missingKinds = requiredPhase0CorpusFixtureKinds.filter(
    (kind) => !availableKinds.has(kind),
  );
  if (missingKinds.length > 0) {
    throw new Error(`Missing corpus fixture descriptors: ${missingKinds.join(", ")}`);
  }
  return parsed;
}
