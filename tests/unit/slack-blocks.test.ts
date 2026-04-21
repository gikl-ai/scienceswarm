import { describe, expect, it } from "vitest";
import { markdownToBlocks, errorBlock } from "@/lib/slack-blocks";

describe("slack-blocks", () => {
  // ── Bold conversion ────────────────────────────────────────────

  describe("bold conversion", () => {
    it("converts **text** to *text*", () => {
      const blocks = markdownToBlocks("This is **bold** text.");
      expect(blocks[0].type).toBe("section");
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toContain("*bold*");
      expect(text).not.toContain("**bold**");
    });

    it("converts multiple bold segments", () => {
      const blocks = markdownToBlocks("**one** and **two**");
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toBe("*one* and *two*");
    });
  });

  // ── Link conversion ───────────────────────────────────────────

  describe("link conversion", () => {
    it("converts [text](url) to <url|text>", () => {
      const blocks = markdownToBlocks("See [docs](https://example.com)");
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toContain("<https://example.com|docs>");
    });
  });

  // ── Code block handling ────────────────────────────────────────

  describe("code block handling", () => {
    it("preserves fenced code blocks as separate section blocks", () => {
      const input = "Text before\n\n```python\nprint('hello')\n```\n\nText after";
      const blocks = markdownToBlocks(input);

      expect(blocks.length).toBeGreaterThanOrEqual(2);
      // At least one block should contain the code
      const codeBlock = blocks.find((b) => {
        const text = (b as { text: { text: string } }).text.text;
        return text.includes("print");
      });
      expect(codeBlock).toBeDefined();
    });

    it("keeps inline code unchanged", () => {
      const blocks = markdownToBlocks("Use `npm install` to install.");
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toContain("`npm install`");
    });
  });

  // ── Long message splitting ─────────────────────────────────────

  describe("long message splitting", () => {
    it("splits messages longer than 3000 chars into multiple blocks", () => {
      // Create a message with multiple paragraphs totaling > 3000 chars
      const para = "A".repeat(1500);
      const longText = `${para}\n\n${para}\n\n${para}`;
      const blocks = markdownToBlocks(longText);

      expect(blocks.length).toBeGreaterThan(1);
      // Each block should be under the limit
      for (const block of blocks) {
        const text = (block as { text: { text: string } }).text.text;
        expect(text.length).toBeLessThanOrEqual(3000);
      }
    });

    it("splits at paragraph boundaries, not mid-content", () => {
      const para1 = "First paragraph. " + "x".repeat(1400);
      const para2 = "Second paragraph. " + "y".repeat(1400);
      const para3 = "Third paragraph. " + "z".repeat(1400);
      const longText = `${para1}\n\n${para2}\n\n${para3}`;
      const blocks = markdownToBlocks(longText);

      expect(blocks.length).toBeGreaterThan(1);
      // First block should contain complete first paragraph
      const firstText = (blocks[0] as { text: { text: string } }).text.text;
      expect(firstText).toContain("First paragraph");
    });
  });

  // ── Empty / edge cases ─────────────────────────────────────────

  describe("edge cases", () => {
    it("produces a fallback block for empty input", () => {
      const blocks = markdownToBlocks("");
      expect(blocks.length).toBe(1);
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toBe("(empty response)");
    });

    it("handles whitespace-only input", () => {
      const blocks = markdownToBlocks("   ");
      expect(blocks.length).toBe(1);
    });

    it("handles text with only bold markers", () => {
      const blocks = markdownToBlocks("**bold**");
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toBe("*bold*");
    });
  });

  // ── errorBlock ─────────────────────────────────────────────────

  describe("errorBlock", () => {
    it("returns a single-block array with the error message", () => {
      const blocks = errorBlock("Something went wrong");
      expect(blocks).toHaveLength(1);
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toContain("Something went wrong");
      expect(text).toContain(":warning:");
    });

    it("bolds the Error label", () => {
      const blocks = errorBlock("oops");
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toContain("*Error:*");
    });
  });
});
