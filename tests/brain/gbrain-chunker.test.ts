import { describe, expect, it } from "vitest";
import { chunkText } from "@/brain/stores/gbrain-chunker";

describe("chunkText", () => {
  it("applies overlap in one direction only between adjacent chunks", () => {
    const chunks = chunkText("one two. three four. five six.", {
      chunkSize: 2,
      chunkOverlap: 1,
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "one two.",
      "two. three four.",
      "four. five six.",
    ]);
  });
});
