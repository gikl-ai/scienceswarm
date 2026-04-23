import { describe, expect, it } from "vitest";
import {
  PaperLibraryErrorEnvelopeSchema,
  PaperLibraryScanSchema,
  paperLibraryError,
} from "@/lib/paper-library/contracts";

describe("paper-library contracts", () => {
  it("accepts a valid scan record", () => {
    const parsed = PaperLibraryScanSchema.parse({
      version: 1,
      id: "scan-1",
      project: "project-alpha",
      rootPath: "/tmp/papers",
      status: "queued",
      createdAt: "2026-04-23T04:00:00.000Z",
      updatedAt: "2026-04-23T04:00:00.000Z",
      counters: {
        detectedFiles: 0,
        identified: 0,
        needsReview: 0,
        readyForApply: 0,
        failed: 0,
      },
    });

    expect(parsed.reviewShardIds).toEqual([]);
    expect(parsed.currentPath).toBeNull();
  });

  it("rejects malformed project slugs and unknown states", () => {
    expect(() =>
      PaperLibraryScanSchema.parse({
        version: 1,
        id: "scan-1",
        project: "../secret",
        rootPath: "/tmp/papers",
        status: "partial",
        createdAt: "2026-04-23T04:00:00.000Z",
        updatedAt: "2026-04-23T04:00:00.000Z",
        counters: {
          detectedFiles: 0,
          identified: 0,
          needsReview: 0,
          readyForApply: 0,
          failed: 0,
        },
      }),
    ).toThrow();
  });

  it("returns typed error envelopes", () => {
    const envelope = paperLibraryError("unsafe_path", "Destination escapes root.", { path: "../x.pdf" });
    expect(PaperLibraryErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });
});

