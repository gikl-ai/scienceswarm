import { describe, expect, it } from "vitest";

import {
  PLACEHOLDER_PATTERNS,
  isPlaceholderValue,
} from "@/lib/setup/placeholder-detection";

describe("isPlaceholderValue", () => {
  describe("path-prefix patterns", () => {
    it("flags /path/to/ prefix", () => {
      const result = isPlaceholderValue("/path/to/project");
      expect(result.isPlaceholder).toBe(true);
      expect(result.reason).toBe(
        "looks like an example path from .env.example",
      );
    });

    it("flags /your/ prefix", () => {
      const result = isPlaceholderValue("/your/obsidian/vault");
      expect(result.isPlaceholder).toBe(true);
      expect(result.reason).toBe("contains placeholder 'your'");
    });

    it("flags /example/ prefix", () => {
      const result = isPlaceholderValue("/example/path/here");
      expect(result.isPlaceholder).toBe(true);
      expect(result.reason).toBe("contains placeholder 'example'");
    });

    it("trims surrounding whitespace before checking prefixes", () => {
      expect(isPlaceholderValue("  /path/to/x  ").isPlaceholder).toBe(true);
    });

    it("does not flag real absolute paths", () => {
      expect(isPlaceholderValue("/Users/jsmith/projects").isPlaceholder).toBe(
        false,
      );
      expect(isPlaceholderValue("/home/alice/data").isPlaceholder).toBe(false);
      expect(isPlaceholderValue("/opt/data/research").isPlaceholder).toBe(
        false,
      );
      expect(isPlaceholderValue("/var/lib/scienceswarm").isPlaceholder).toBe(
        false,
      );
    });

    it("is case-sensitive on path prefixes (so /Path/To/ does NOT flag)", () => {
      // Real user paths on macOS frequently contain capitalised
      // segments like `/Users/...`. Path-prefix rules only trigger
      // on lowercase `/path/to/`, `/your/`, `/example/` because those
      // are the literal casings shipped in `.env.example`.
      expect(isPlaceholderValue("/Path/To/project").isPlaceholder).toBe(false);
      expect(isPlaceholderValue("/Your/Vault").isPlaceholder).toBe(false);
      expect(isPlaceholderValue("/Example/data").isPlaceholder).toBe(false);
    });
  });

  describe("exact-token patterns", () => {
    const exactTokens = [
      "replace-me",
      "replace_me",
      "REPLACE",
      "your-key-here",
      "your_key_here",
      "changeme",
      "change-me",
    ];

    for (const token of exactTokens) {
      it(`flags exact token: ${token}`, () => {
        const result = isPlaceholderValue(token);
        expect(result.isPlaceholder).toBe(true);
        expect(result.reason).toBe("is a placeholder value");
      });

      it(`flags ${token} case-insensitively`, () => {
        expect(isPlaceholderValue(token.toUpperCase()).isPlaceholder).toBe(
          true,
        );
        expect(isPlaceholderValue(token.toLowerCase()).isPlaceholder).toBe(
          true,
        );
      });
    }

    it("does not flag values that merely contain a placeholder token", () => {
      // The exact-token matcher must require a full match; it should
      // not fire on substrings. `REPLACE` is a plausible substring in
      // a user's real key name or project identifier.
      expect(isPlaceholderValue("prefix-replace-me-suffix").isPlaceholder).toBe(
        false,
      );
      expect(isPlaceholderValue("replacement-key-2024").isPlaceholder).toBe(
        false,
      );
      expect(isPlaceholderValue("changemeNow").isPlaceholder).toBe(false);
    });
  });

  describe("OpenAI key placeholder pattern", () => {
    it("flags the literal sk-proj-REPLACE... from .env.example", () => {
      const result = isPlaceholderValue("sk-proj-REPLACE_WITH_YOUR_KEY");
      expect(result.isPlaceholder).toBe(true);
      expect(result.reason).toBe(
        "looks like a placeholder OpenAI key from .env.example",
      );
    });

    it("flags the minimal sk-proj-REPLACE form", () => {
      expect(isPlaceholderValue("sk-proj-REPLACE").isPlaceholder).toBe(true);
    });

    it("does not flag real OpenAI project keys", () => {
      expect(
        isPlaceholderValue("sk-proj-abc123xyz789realkey").isPlaceholder,
      ).toBe(false);
    });

    it("is case-sensitive on sk-proj prefix", () => {
      // The regex uses a literal `sk-proj-REPLACE` with no `i` flag,
      // because real project keys always start with lowercase
      // `sk-proj-` and never embed the uppercase literal `REPLACE`.
      expect(isPlaceholderValue("SK-PROJ-REPLACE").isPlaceholder).toBe(false);
      expect(isPlaceholderValue("sk-proj-replace").isPlaceholder).toBe(false);
    });

    it("flags the literal sk-your-key-here shipped in .env.example / install.sh", () => {
      // `.env.example` and every bootstrap script ship this exact
      // value as the OPENAI_API_KEY default. A brand-new user who
      // copies `.env.example` verbatim and hits Save must get a
      // placeholder rejection, not an opaque 401 at request time.
      const result = isPlaceholderValue("sk-your-key-here");
      expect(result.isPlaceholder).toBe(true);
      expect(result.reason).toMatch(/placeholder/i);
    });

    it("flags sk-your-key-here case-insensitively", () => {
      expect(isPlaceholderValue("SK-YOUR-KEY-HERE").isPlaceholder).toBe(true);
    });
  });

  describe("NextAuth placeholder pattern", () => {
    it("flags the literal your-secret-here shipped in .env.example", () => {
      const result = isPlaceholderValue("your-secret-here");
      expect(result.isPlaceholder).toBe(true);
      expect(result.reason).toBe("is a placeholder value");
    });

    it("flags your-secret-here case-insensitively", () => {
      expect(isPlaceholderValue("YOUR-SECRET-HERE").isPlaceholder).toBe(true);
    });
  });

  describe("xxxxx content pattern", () => {
    it("flags five consecutive x's", () => {
      const result = isPlaceholderValue("prefix-xxxxx-suffix");
      expect(result.isPlaceholder).toBe(true);
      expect(result.reason).toBe("contains placeholder 'xxxxx'");
    });

    it("flags more than five x's", () => {
      expect(isPlaceholderValue("xxxxxxx").isPlaceholder).toBe(true);
    });

    it("is case-insensitive on x's (XXXXX also flags)", () => {
      expect(isPlaceholderValue("XXXXX").isPlaceholder).toBe(true);
      expect(isPlaceholderValue("abcXXxxXdef").isPlaceholder).toBe(true);
    });

    it("does not flag fewer than five consecutive x's", () => {
      expect(isPlaceholderValue("xxxx").isPlaceholder).toBe(false);
      expect(isPlaceholderValue("xyxyxyxy").isPlaceholder).toBe(false);
    });

    it("requires x's to be consecutive (5 mixed-case in a row matches)", () => {
      // `/x{5,}/i` requires 5 consecutive characters that each match
      // `[xX]`. The five characters don't all need the same case.
      expect(isPlaceholderValue("xXxXx").isPlaceholder).toBe(true);
    });
  });

  describe("empty and whitespace inputs", () => {
    it("returns not-a-placeholder for empty string", () => {
      const result = isPlaceholderValue("");
      expect(result.isPlaceholder).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it("returns not-a-placeholder for undefined", () => {
      const result = isPlaceholderValue(undefined);
      expect(result.isPlaceholder).toBe(false);
      expect(result.reason).toBeUndefined();
    });

    it("returns not-a-placeholder for whitespace-only strings", () => {
      expect(isPlaceholderValue("   ").isPlaceholder).toBe(false);
      expect(isPlaceholderValue("\t\n ").isPlaceholder).toBe(false);
    });
  });

  describe("real values", () => {
    it("does not flag plausible API keys", () => {
      expect(
        isPlaceholderValue(
          "sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
        ).isPlaceholder,
      ).toBe(false);
      expect(
        isPlaceholderValue("xoxb-1234567890-notarealslacktoken").isPlaceholder,
      ).toBe(false);
    });

    it("does not flag plausible URLs", () => {
      expect(
        isPlaceholderValue("http://localhost:3001").isPlaceholder,
      ).toBe(false);
      expect(
        isPlaceholderValue("https://api.openai.com/v1").isPlaceholder,
      ).toBe(false);
    });

    it("does not flag plausible model identifiers", () => {
      expect(isPlaceholderValue("gpt-5.4").isPlaceholder).toBe(false);
      expect(isPlaceholderValue("claude-opus-4-6").isPlaceholder).toBe(false);
    });
  });
});

describe("PLACEHOLDER_PATTERNS export", () => {
  it("exposes the pattern list for documentation/debugging", () => {
    // Sanity: the list is non-empty and each entry has the public shape.
    expect(PLACEHOLDER_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of PLACEHOLDER_PATTERNS) {
      expect(typeof pattern.id).toBe("string");
      expect(pattern.id.length).toBeGreaterThan(0);
      expect(typeof pattern.reason).toBe("string");
      expect(pattern.reason.length).toBeGreaterThan(0);
      expect(pattern.matcher).toBeDefined();
    }
  });

  it("covers every documented pattern category", () => {
    const ids = PLACEHOLDER_PATTERNS.map((p) => p.id);
    // Path prefixes
    expect(ids).toContain("path-to-prefix");
    expect(ids).toContain("your-prefix");
    expect(ids).toContain("example-prefix");
    // Exact tokens
    expect(ids).toContain("exact-replace-me");
    expect(ids).toContain("exact-changeme");
    // OpenAI placeholder
    expect(ids).toContain("openai-sk-proj-replace");
    // xxxxx content
    expect(ids).toContain("xxxxx-content");
  });
});
