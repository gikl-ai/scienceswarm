import { describe, expect, it } from "vitest";

import {
  assertSha256Hex,
  basenameOnly,
  isGbrainFileObjectId,
  isSha256Hex,
  parseFileObjectId,
  toFileObjectId,
} from "@/brain/gbrain-data-contracts";

describe("gbrain data contracts", () => {
  it("validates sha256 and file object ids", () => {
    const sha = "a".repeat(64);
    expect(isSha256Hex(sha)).toBe(true);
    expect(isSha256Hex("not-a-sha")).toBe(false);
    expect(assertSha256Hex(sha.toUpperCase())).toBe(sha);
    expect(toFileObjectId(sha)).toBe(`sha256:${sha}`);
    expect(parseFileObjectId(`sha256:${sha}`)).toEqual({
      id: `sha256:${sha}`,
      sha256: sha,
    });
    expect(isGbrainFileObjectId(`sha256:${sha}`)).toBe(true);
    expect(isGbrainFileObjectId(`md5:${sha}`)).toBe(false);
  });

  it("accepts basename-only filenames with repeated dots", () => {
    expect(basenameOnly("my..paper.pdf")).toBe("my..paper.pdf");
    expect(basenameOnly("data..final.csv")).toBe("data..final.csv");
    expect(basenameOnly("..")).toBeNull();
    expect(basenameOnly("../paper.pdf")).toBeNull();
    expect(basenameOnly("nested/paper.pdf")).toBeNull();
    expect(basenameOnly("nested\\paper.pdf")).toBeNull();
  });
});
