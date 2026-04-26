import { describe, it, expect } from "vitest";
import {
  ArtifactFrontmatterSchema,
  CoverLetterFrontmatterSchema,
  CritiqueFrontmatterSchema,
  CodeFrontmatterSchema,
  DatasetFrontmatterSchema,
  PaperFrontmatterSchema,
  RevisionFrontmatterSchema,
  RevisionPlanFrontmatterSchema,
  TranslationFrontmatterSchema,
  StatsRerunFrontmatterSchema,
  FigureFrontmatterSchema,
  buildChildSlug,
  parseArtifactFrontmatter,
} from "@/brain/audit-revise-schema";

const iso = "2026-04-14T22:00:00Z";
const sha =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("PaperFrontmatterSchema", () => {
  it.each([
    {
      name: "minimal required fields",
      input: { type: "paper", project: "hubble-1929" },
    },
    {
      name: "full field set",
      input: {
        type: "paper",
        project: "hubble-1929",
        source_filename: "hubble-1929.pdf",
        sha256: sha,
        uploaded_at: iso,
        uploaded_by: "@scienceswarm-demo",
        title: "A Relation Between Distance and Radial Velocity",
        authors: ["Edwin Hubble"],
        year: 1929,
        page_count: 6,
        word_count: 4200,
      },
    },
    {
      name: "paper with multi-author list",
      input: {
        type: "paper",
        project: "mendel-1866",
        authors: ["Gregor Mendel", "William Bateson"],
        year: 1866,
      },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(PaperFrontmatterSchema.parse(input)).toEqual(
      expect.objectContaining({ type: "paper" }),
    );
  });

  it.each([
    {
      name: "missing type",
      input: { project: "hubble-1929" },
    },
    {
      name: "invalid year",
      input: { type: "paper", project: "hubble-1929", year: 999 },
    },
    {
      name: "non-array authors",
      input: { type: "paper", project: "hubble-1929", authors: "Hubble" },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => PaperFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("DatasetFrontmatterSchema", () => {
  it.each([
    {
      name: "dataset with parent",
      input: {
        type: "dataset",
        project: "mendel-1866",
        parent: "mendel-1866",
      },
    },
    {
      name: "dataset with column list",
      input: {
        type: "dataset",
        project: "mendel-1866",
        columns: ["seed", "color", "count"],
        row_count: 7,
      },
    },
    {
      name: "dataset without parent",
      input: {
        type: "dataset",
        project: "mendel-1866",
        source_filename: "mendel-counts.csv",
      },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(DatasetFrontmatterSchema.parse(input).type).toBe("dataset");
  });

  it.each([
    {
      name: "wrong type discriminator",
      input: { type: "paper", project: "mendel-1866" },
    },
    {
      name: "row_count must be integer",
      input: { type: "dataset", project: "mendel-1866", row_count: 1.5 },
    },
    {
      name: "invalid parent slug",
      input: { type: "dataset", project: "mendel-1866", parent: "Mendel!" },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => DatasetFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("CodeFrontmatterSchema", () => {
  it.each([
    {
      name: "python script",
      input: {
        type: "code",
        project: "mendel-1866",
        language: "python",
        line_count: 42,
      },
    },
    {
      name: "tied to parent paper",
      input: {
        type: "code",
        project: "mendel-1866",
        parent: "mendel-1866",
      },
    },
    {
      name: "code without language",
      input: { type: "code", project: "hubble-1929" },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(CodeFrontmatterSchema.parse(input).type).toBe("code");
  });

  it.each([
    {
      name: "empty project slug",
      input: { type: "code", project: "" },
    },
    {
      name: "negative line_count",
      input: { type: "code", project: "mendel-1866", line_count: -1 },
    },
    {
      name: "language must be a string",
      input: { type: "code", project: "mendel-1866", language: 42 },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => CodeFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("CritiqueFrontmatterSchema", () => {
  it.each([
    {
      name: "professional profile minimal",
      input: {
        type: "critique",
        project: "hubble-1929",
        parent: "hubble-1929",
        style_profile: "professional",
        finding_count: 11,
      },
    },
    {
      name: "referee profile with Descartes wall time",
      input: {
        type: "critique",
        project: "mendel-1866",
        parent: "mendel-1866",
        style_profile: "referee",
        finding_count: 8,
        raw_descartes_findings_count: 55,
        descartes_wall_time_s: 612,
      },
    },
    {
      name: "internal_red_team",
      input: {
        type: "critique",
        project: "hubble-1929",
        parent: "hubble-1929",
        style_profile: "internal_red_team",
        finding_count: 0,
      },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(CritiqueFrontmatterSchema.parse(input).type).toBe("critique");
  });

  it.each([
    {
      name: "missing parent",
      input: {
        type: "critique",
        project: "hubble-1929",
        style_profile: "professional",
        finding_count: 3,
      },
    },
    {
      name: "unknown style_profile",
      input: {
        type: "critique",
        project: "hubble-1929",
        parent: "hubble-1929",
        style_profile: "harsh",
        finding_count: 3,
      },
    },
    {
      name: "finding_count must be >= 0",
      input: {
        type: "critique",
        project: "hubble-1929",
        parent: "hubble-1929",
        style_profile: "professional",
        finding_count: -1,
      },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => CritiqueFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("RevisionPlanFrontmatterSchema", () => {
  it.each([
    {
      name: "draft plan",
      input: {
        type: "revision_plan",
        project: "hubble-1929",
        parent: "hubble-1929",
        critique: "hubble-1929-critique",
        status: "draft",
        version: 1,
        scope: "text_only",
      },
    },
    {
      name: "approved with timestamp",
      input: {
        type: "revision_plan",
        project: "mendel-1866",
        parent: "mendel-1866",
        critique: "mendel-1866-critique",
        status: "approved",
        version: 2,
        scope: "full",
        approved_at: iso,
      },
    },
    {
      name: "superseded plan",
      input: {
        type: "revision_plan",
        project: "hubble-1929",
        parent: "hubble-1929",
        critique: "hubble-1929-critique",
        status: "superseded",
        version: 1,
        scope: "text_only",
      },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(RevisionPlanFrontmatterSchema.parse(input).type).toBe(
      "revision_plan",
    );
  });

  it.each([
    {
      name: "unknown status",
      input: {
        type: "revision_plan",
        project: "hubble-1929",
        parent: "hubble-1929",
        critique: "hubble-1929-critique",
        status: "pending-review",
        version: 1,
        scope: "text_only",
      },
    },
    {
      name: "version must be >= 1",
      input: {
        type: "revision_plan",
        project: "hubble-1929",
        parent: "hubble-1929",
        critique: "hubble-1929-critique",
        status: "draft",
        version: 0,
        scope: "text_only",
      },
    },
    {
      name: "approved_at must be ISO",
      input: {
        type: "revision_plan",
        project: "hubble-1929",
        parent: "hubble-1929",
        critique: "hubble-1929-critique",
        status: "approved",
        version: 1,
        scope: "text_only",
        approved_at: "yesterday",
      },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => RevisionPlanFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("RevisionFrontmatterSchema", () => {
  it.each([
    {
      name: "revision with job handle",
      input: {
        type: "revision",
        project: "hubble-1929",
        parent: "hubble-1929",
        plan: "hubble-1929-revision-plan",
        job_handle: "job_01JXXX",
        artifact_files: [sha],
      },
    },
    {
      name: "revision without files",
      input: {
        type: "revision",
        project: "hubble-1929",
        parent: "hubble-1929",
        plan: "hubble-1929-revision-plan",
      },
    },
    {
      name: "revision with multiple artifact sha",
      input: {
        type: "revision",
        project: "mendel-1866",
        parent: "mendel-1866",
        plan: "mendel-1866-revision-plan",
        artifact_files: [sha, sha],
      },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(RevisionFrontmatterSchema.parse(input).type).toBe("revision");
  });

  it.each([
    {
      name: "missing plan",
      input: {
        type: "revision",
        project: "hubble-1929",
        parent: "hubble-1929",
      },
    },
    {
      name: "artifact_files must be sha256 hex",
      input: {
        type: "revision",
        project: "hubble-1929",
        parent: "hubble-1929",
        plan: "hubble-1929-revision-plan",
        artifact_files: ["not-a-hash"],
      },
    },
    {
      name: "job_handle must be non-empty",
      input: {
        type: "revision",
        project: "hubble-1929",
        parent: "hubble-1929",
        plan: "hubble-1929-revision-plan",
        job_handle: "",
      },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => RevisionFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("TranslationFrontmatterSchema", () => {
  it.each([
    {
      name: "english translation",
      input: {
        type: "translation",
        project: "mendel-1866",
        translation_of: "mendel-1866",
        language: "en",
        back_translation_similarity: 0.99,
      },
    },
    {
      name: "german translation",
      input: {
        type: "translation",
        project: "mendel-1866",
        translation_of: "mendel-1866",
        language: "de",
        back_translation_similarity: 0.83,
      },
    },
    {
      name: "translation with base metadata",
      input: {
        type: "translation",
        project: "hubble-1929",
        translation_of: "hubble-1929",
        language: "fr",
        back_translation_similarity: 0.8,
        uploaded_at: iso,
        uploaded_by: "@scienceswarm-demo",
      },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(TranslationFrontmatterSchema.parse(input).type).toBe("translation");
  });

  it.each([
    {
      name: "missing source",
      input: { type: "translation", project: "mendel-1866", language: "en" },
    },
    {
      name: "similarity above one",
      input: {
        type: "translation",
        project: "mendel-1866",
        translation_of: "mendel-1866",
        language: "en",
        back_translation_similarity: 1.1,
      },
    },
    {
      name: "empty language",
      input: {
        type: "translation",
        project: "mendel-1866",
        translation_of: "mendel-1866",
        language: "",
        back_translation_similarity: 0.9,
      },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => TranslationFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("StatsRerunFrontmatterSchema", () => {
  const statsInput = { slug: "mendel-counts", sha256: sha };

  it.each([
    {
      name: "minimal provenance",
      input: {
        type: "stats_rerun",
        project: "mendel-1866",
        parent: "mendel-1866",
        inputs: [statsInput],
        code: sha,
        results: { p_value: 0.91 },
        seed: 42,
        env: { python: "3.12.0", scipy: "1.13.0" },
      },
    },
    {
      name: "with plan",
      input: {
        type: "stats_rerun",
        project: "mendel-1866",
        parent: "mendel-1866",
        plan: "mendel-1866-revision-plan",
        inputs: [
          { slug: "mendel-1866", sha256: sha },
          { slug: "chisq", sha256: sha },
        ],
        code: sha,
        results: { posterior_mean: 0.75 },
        seed: 42,
        env: { python: "3.12.0", pymc: "5.0.0", matplotlib: "3.9.0" },
      },
    },
    {
      name: "structured result object",
      input: {
        type: "stats_rerun",
        project: "mendel-1866",
        parent: "mendel-1866",
        inputs: [statsInput],
        code: sha,
        results: { baseline: { chisq: 0.47 }, posterior: { mean: 0.749 } },
        seed: 42,
        env: { python: "3.12.0" },
      },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(StatsRerunFrontmatterSchema.parse(input).type).toBe("stats_rerun");
  });

  it.each([
    {
      name: "missing inputs",
      input: {
        type: "stats_rerun",
        project: "mendel-1866",
        parent: "mendel-1866",
        inputs: [],
        code: sha,
        results: {},
        seed: 42,
        env: { python: "3.12.0" },
      },
    },
    {
      name: "code must be sha",
      input: {
        type: "stats_rerun",
        project: "mendel-1866",
        parent: "mendel-1866",
        inputs: [statsInput],
        code: "not-a-sha",
        results: {},
        seed: 42,
        env: { python: "3.12.0" },
      },
    },
    {
      name: "env values must be strings",
      input: {
        type: "stats_rerun",
        project: "mendel-1866",
        parent: "mendel-1866",
        inputs: [statsInput],
        code: sha,
        results: {},
        seed: 42,
        env: { python: 3.12 },
      },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => StatsRerunFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("FigureFrontmatterSchema", () => {
  it.each([
    {
      name: "png wrapper",
      input: {
        type: "figure",
        project: "mendel-1866",
        parent: "mendel-1866-stats-rerun",
        fileObjectId: `sha256:${sha}`,
        mime: "image/png",
        size: 12345,
      },
    },
    {
      name: "with source filename",
      input: {
        type: "figure",
        project: "mendel-1866",
        parent: "mendel-1866-stats-rerun",
        source_filename: "figure-1.png",
        fileObjectId: `sha256:${sha}`,
        mime: "image/png",
        size: 1,
      },
    },
    {
      name: "large png",
      input: {
        type: "figure",
        project: "mendel-1866",
        parent: "mendel-1866-stats-rerun",
        fileObjectId: "figure-file-1",
        mime: "image/png",
        size: 2_000_000,
      },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(FigureFrontmatterSchema.parse(input).type).toBe("figure");
  });

  it.each([
    {
      name: "missing parent",
      input: {
        type: "figure",
        project: "mendel-1866",
        fileObjectId: `sha256:${sha}`,
        mime: "image/png",
        size: 12345,
      },
    },
    {
      name: "wrong mime",
      input: {
        type: "figure",
        project: "mendel-1866",
        parent: "mendel-1866-stats-rerun",
        fileObjectId: `sha256:${sha}`,
        mime: "image/jpeg",
        size: 12345,
      },
    },
    {
      name: "size must be positive",
      input: {
        type: "figure",
        project: "mendel-1866",
        parent: "mendel-1866-stats-rerun",
        fileObjectId: `sha256:${sha}`,
        mime: "image/png",
        size: 0,
      },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => FigureFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("CoverLetterFrontmatterSchema", () => {
  it.each([
    {
      name: "letter with journal",
      input: {
        type: "cover_letter",
        project: "hubble-1929",
        revision: "hubble-1929-revision",
        target_journal: "PNAS",
      },
    },
    {
      name: "letter without journal",
      input: {
        type: "cover_letter",
        project: "hubble-1929",
        revision: "hubble-1929-revision",
      },
    },
    {
      name: "mendel letter",
      input: {
        type: "cover_letter",
        project: "mendel-1866",
        revision: "mendel-1866-revision",
        target_journal: "Verhandlungen des naturforschenden Vereines",
      },
    },
  ])("accepts valid: $name", ({ input }) => {
    expect(CoverLetterFrontmatterSchema.parse(input).type).toBe(
      "cover_letter",
    );
  });

  it.each([
    {
      name: "missing revision slug",
      input: { type: "cover_letter", project: "hubble-1929" },
    },
    {
      name: "empty target_journal string",
      input: {
        type: "cover_letter",
        project: "hubble-1929",
        revision: "hubble-1929-revision",
        target_journal: "",
      },
    },
    {
      name: "wrong discriminator",
      input: {
        type: "letter",
        project: "hubble-1929",
        revision: "hubble-1929-revision",
      },
    },
  ])("rejects invalid: $name", ({ input }) => {
    expect(() => CoverLetterFrontmatterSchema.parse(input)).toThrow();
  });
});

describe("ArtifactFrontmatterSchema discriminated union", () => {
  it("parses each artifact type through the union", () => {
    const inputs = [
      { type: "paper", project: "hubble-1929" },
      { type: "dataset", project: "mendel-1866", columns: ["a"] },
      { type: "code", project: "mendel-1866", language: "python" },
      {
        type: "critique",
        project: "hubble-1929",
        parent: "hubble-1929",
        style_profile: "professional",
        finding_count: 11,
      },
      {
        type: "revision_plan",
        project: "hubble-1929",
        parent: "hubble-1929",
        critique: "hubble-1929-critique",
        status: "draft",
        version: 1,
        scope: "text_only",
      },
      {
        type: "translation",
        project: "mendel-1866",
        translation_of: "mendel-1866",
        language: "en",
        back_translation_similarity: 0.99,
      },
      {
        type: "stats_rerun",
        project: "mendel-1866",
        parent: "mendel-1866",
        inputs: [{ slug: "mendel-counts", sha256: sha }],
        code: sha,
        results: { p_value: 0.91 },
        seed: 42,
        env: { python: "3.12.0" },
      },
      {
        type: "figure",
        project: "mendel-1866",
        parent: "mendel-1866-stats-rerun",
        fileObjectId: `sha256:${sha}`,
        mime: "image/png",
        size: 12345,
      },
      {
        type: "revision",
        project: "hubble-1929",
        parent: "hubble-1929",
        plan: "hubble-1929-revision-plan",
      },
      {
        type: "cover_letter",
        project: "hubble-1929",
        revision: "hubble-1929-revision",
      },
    ];
    for (const input of inputs) {
      expect(parseArtifactFrontmatter(input).type).toBe(input.type);
    }
  });

  it("rejects unknown type discriminators via the union", () => {
    expect(() =>
      ArtifactFrontmatterSchema.parse({ type: "job_run", project: "x" }),
    ).toThrow();
  });
});

describe("buildChildSlug", () => {
  it("composes deterministic child slugs for every derivative kind", () => {
    expect(buildChildSlug("hubble-1929", "critique")).toBe(
      "hubble-1929-critique",
    );
    expect(buildChildSlug("hubble-1929", "revision-plan")).toBe(
      "hubble-1929-revision-plan",
    );
    expect(buildChildSlug("hubble-1929", "revision")).toBe(
      "hubble-1929-revision",
    );
    expect(buildChildSlug("hubble-1929", "cover-letter")).toBe(
      "hubble-1929-cover-letter",
    );
  });

  it("rejects parent slugs that would violate the slug rule", () => {
    expect(() => buildChildSlug("Hubble_1929", "critique")).toThrow();
    expect(() => buildChildSlug("", "critique")).toThrow();
    expect(() => buildChildSlug("hubble 1929", "critique")).toThrow();
    expect(() => buildChildSlug("-hubble", "critique")).toThrow();
    expect(() => buildChildSlug("hubble-", "critique")).toThrow();
    expect(() => buildChildSlug("hubble--1929", "critique")).toThrow();
  });
});

describe("slug rule edge cases (via PaperFrontmatterSchema)", () => {
  it.each([
    { name: "single token", project: "hubble" },
    { name: "multi-token", project: "hubble-1929-professional" },
    { name: "version suffix", project: "hubble-1929-v2" },
    { name: "digits only", project: "1929" },
  ])("accepts: $name", ({ project }) => {
    expect(() =>
      PaperFrontmatterSchema.parse({ type: "paper", project }),
    ).not.toThrow();
  });

  it.each([
    { name: "leading hyphen", project: "-hubble" },
    { name: "trailing hyphen", project: "hubble-" },
    { name: "consecutive hyphens", project: "hubble--1929" },
    { name: "underscore", project: "hubble_1929" },
    { name: "uppercase", project: "Hubble-1929" },
    { name: "space", project: "hubble 1929" },
    { name: "empty", project: "" },
  ])("rejects: $name", ({ project }) => {
    expect(() =>
      PaperFrontmatterSchema.parse({ type: "paper", project }),
    ).toThrow();
  });
});

describe("ISO 8601 date edge cases (via PaperFrontmatterSchema.uploaded_at)", () => {
  it.each([
    { name: "UTC zulu", value: "2026-04-14T22:00:00Z" },
    { name: "UTC with ms", value: "2026-04-14T22:00:00.123Z" },
    { name: "positive offset", value: "2026-04-14T22:00:00+09:00" },
    { name: "negative offset", value: "2026-04-14T22:00:00-07:00" },
  ])("accepts: $name", ({ value }) => {
    expect(() =>
      PaperFrontmatterSchema.parse({
        type: "paper",
        project: "hubble-1929",
        uploaded_at: value,
      }),
    ).not.toThrow();
  });

  it.each([
    { name: "RFC 2822 header", value: "Tue, 14 Apr 2026 22:00:00 GMT" },
    { name: "en-US locale", value: "April 14 2026" },
    { name: "date-only", value: "2026-04-14" },
    { name: "missing Z or offset", value: "2026-04-14T22:00:00" },
    { name: "nonsense", value: "not a date" },
  ])("rejects: $name", ({ value }) => {
    expect(() =>
      PaperFrontmatterSchema.parse({
        type: "paper",
        project: "hubble-1929",
        uploaded_at: value,
      }),
    ).toThrow();
  });
});
