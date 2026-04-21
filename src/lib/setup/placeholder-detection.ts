// Placeholder-value detection for the `/setup` page.
//
// When a user copies `.env.example` to `.env` without filling in
// real values, most of the entries look "plausible" (strings, paths,
// tokens) but actually point at nothing. If we naively hand those
// strings to OpenAI, to the OpenHands proxy, or to a local filesystem
// operation, we get confusing downstream errors that have nothing to
// do with the real problem: the value is still a template placeholder.
//
// The rules here are deliberately conservative. Each rule has an
// obvious template origin (it actually appears in `.env.example`, or
// in the standard OpenAI / dotenv shipping conventions), so false
// positives on real user data are unlikely. If a rule were to match a
// plausible production value we'd rather relax the rule than nudge
// users to work around the check.
//
// Pure module. No I/O, no globals, no mutable state.
//
// Shape:
//   isPlaceholderValue(value) -> { isPlaceholder: boolean, reason?: string }
//   PLACEHOLDER_PATTERNS       -> the ordered rule list, for docs/debugging
//
// The first matching pattern wins. Empty strings and `undefined`
// always return `{ isPlaceholder: false }` — a missing env var is a
// separate failure mode from a templated one, and other parts of the
// setup page distinguish them.

export interface PlaceholderResult {
  isPlaceholder: boolean;
  reason?: string;
}

export type PlaceholderMatcher =
  | { kind: "prefix"; prefix: string; caseInsensitive?: boolean }
  | { kind: "exact"; value: string; caseInsensitive?: boolean }
  | { kind: "regex"; pattern: RegExp };

export interface PlaceholderPattern {
  /** Short identifier; useful when surfacing reasons in tests/logs. */
  readonly id: string;
  /** How to match. */
  readonly matcher: PlaceholderMatcher;
  /** Human-readable reason returned when this pattern matches. */
  readonly reason: string;
}

/**
 * Ordered list of placeholder patterns. The first one that matches an
 * input wins. Keep the entries in this order: path-shaped prefixes,
 * then exact tokens, then regex-based content matchers. Order is part
 * of the contract (we want `/your/foo` to report "your" rather than
 * "example" if we later added overlap).
 */
export const PLACEHOLDER_PATTERNS: readonly PlaceholderPattern[] = [
  {
    id: "path-to-prefix",
    matcher: { kind: "prefix", prefix: "/path/to/" },
    reason: "looks like an example path from .env.example",
  },
  {
    id: "your-prefix",
    matcher: { kind: "prefix", prefix: "/your/" },
    reason: "contains placeholder 'your'",
  },
  {
    id: "example-prefix",
    matcher: { kind: "prefix", prefix: "/example/" },
    reason: "contains placeholder 'example'",
  },
  {
    id: "exact-replace-me",
    matcher: { kind: "exact", value: "replace-me", caseInsensitive: true },
    reason: "is a placeholder value",
  },
  {
    id: "exact-replace_me",
    matcher: { kind: "exact", value: "replace_me", caseInsensitive: true },
    reason: "is a placeholder value",
  },
  {
    id: "exact-replace",
    matcher: { kind: "exact", value: "REPLACE", caseInsensitive: true },
    reason: "is a placeholder value",
  },
  {
    id: "exact-your-key-here",
    matcher: { kind: "exact", value: "your-key-here", caseInsensitive: true },
    reason: "is a placeholder value",
  },
  {
    id: "exact-your_key_here",
    matcher: { kind: "exact", value: "your_key_here", caseInsensitive: true },
    reason: "is a placeholder value",
  },
  {
    id: "exact-changeme",
    matcher: { kind: "exact", value: "changeme", caseInsensitive: true },
    reason: "is a placeholder value",
  },
  {
    id: "exact-change-me",
    matcher: { kind: "exact", value: "change-me", caseInsensitive: true },
    reason: "is a placeholder value",
  },
  {
    id: "openai-sk-proj-replace",
    // Case-sensitive prefix on purpose: `sk-proj-` is OpenAI's project
    // key namespace, and `.env.example` ships the exact literal
    // `sk-proj-REPLACE...`. A real project key starts with a long
    // random suffix, so there's no collision risk with production
    // values — and requiring the exact casing avoids flagging any
    // legitimate value that happens to contain those letters.
    matcher: { kind: "regex", pattern: /^sk-proj-REPLACE.*/ },
    reason: "looks like a placeholder OpenAI key from .env.example",
  },
  {
    id: "openai-sk-your-key-here",
    // `.env.example` and the `install.sh` / `setup.sh` / `start.sh`
    // bootstrap scripts ship `OPENAI_API_KEY=sk-your-key-here`. If a
    // new user copies that verbatim and hits Save, downstream calls
    // will fail with an opaque 401 rather than "this is still a
    // placeholder". Match the whole literal case-insensitively — a
    // real OpenAI key is a long random string, so `sk-your-key-here`
    // can't be a collision.
    matcher: { kind: "exact", value: "sk-your-key-here", caseInsensitive: true },
    reason: "is the placeholder OpenAI key from .env.example",
  },
  {
    id: "exact-your-secret-here",
    // `.env.example` ships `NEXTAUTH_SECRET=your-secret-here`. It is
    // not currently a required setup field, but the detection module
    // is shared across every field, and failing to catch this would
    // be a latent UX trap the first time we surface NextAuth to the
    // setup page.
    matcher: { kind: "exact", value: "your-secret-here", caseInsensitive: true },
    reason: "is a placeholder value",
  },
  {
    id: "xxxxx-content",
    matcher: { kind: "regex", pattern: /x{5,}/i },
    reason: "contains placeholder 'xxxxx'",
  },
];

function matches(value: string, matcher: PlaceholderMatcher): boolean {
  switch (matcher.kind) {
    case "prefix": {
      if (matcher.caseInsensitive) {
        return value.toLowerCase().startsWith(matcher.prefix.toLowerCase());
      }
      return value.startsWith(matcher.prefix);
    }
    case "exact": {
      if (matcher.caseInsensitive) {
        return value.toLowerCase() === matcher.value.toLowerCase();
      }
      return value === matcher.value;
    }
    case "regex":
      return matcher.pattern.test(value);
  }
}

/**
 * Classify `value` as placeholder or not. Leading and trailing
 * whitespace are trimmed before matching — a value of `"  replace-me "`
 * is just as much a placeholder as `"replace-me"`, and users
 * frequently paste values with stray whitespace.
 *
 * Empty strings and `undefined` are intentionally *not* placeholders.
 * They represent "nothing set", which the caller handles separately
 * from "set to a template string".
 */
export function isPlaceholderValue(
  value: string | undefined,
): PlaceholderResult {
  if (value === undefined) {
    return { isPlaceholder: false };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { isPlaceholder: false };
  }
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (matches(trimmed, pattern.matcher)) {
      return { isPlaceholder: true, reason: pattern.reason };
    }
  }
  return { isPlaceholder: false };
}
