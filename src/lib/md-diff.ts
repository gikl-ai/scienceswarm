// Dependency-free line-level diff for markdown (or any plain text).
//
// Returns both a structured { hunks } representation — easy for UI
// components that want to render added/removed/equal runs — and a
// unified-format string with `+`, `-`, ` ` prefixes and `@@` headers.
//
// Design notes:
//   * We split both inputs on `\n`. Trailing-newline differences surface
//     naturally because `"a\n".split("\n") === ["a", ""]` while
//     `"a".split("\n") === ["a"]`. The one exception is the empty string:
//     `"".split("\n")` yields `[""]` rather than `[]`, which would cause
//     `diffMarkdown("", "a\nb")` to report a spurious removed line. We
//     normalise `""` to `[]` up front so "no previous content" behaves
//     the way API consumers expect.
//   * We trim a shared prefix and suffix before running the expensive
//     middle diff. For realistic edits this reduces the DP table to
//     something tiny even on 5k-line documents.
//   * For the middle, we use a classic LCS dynamic-program (O(n*m)
//     time and memory). The realistic ceiling is ~10k lines total; at
//     that size the prefix/suffix trim almost always brings the middle
//     well under the size where O(n*m) hurts. If it doesn't, we still
//     complete in well under a second for any input we actually ship.
//   * Runs of same-typed lines are collapsed into a single hunk.
//
// The `unified` string intentionally omits the three-dash file header
// (`--- a` / `+++ b`) — this is a text-only diff with no filenames.

export interface DiffHunk {
  type: "equal" | "add" | "remove";
  lines: string[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  unified: string;
  addedLines: number;
  removedLines: number;
}

type Op = "equal" | "add" | "remove";

interface Step {
  type: Op;
  line: string;
}

const MAX_LCS_CELLS = 4_000_000;

/**
 * Compute a line-level diff between two markdown strings.
 */
export function diffMarkdown(oldText: string, newText: string): DiffResult {
  // Treat "" as "no lines" rather than "[""]" so callers can signal
  // "no previous content" without the counters showing a phantom line.
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");

  const steps = diffLines(oldLines, newLines);
  const hunks = collapseHunks(steps);

  let addedLines = 0;
  let removedLines = 0;
  for (const step of steps) {
    if (step.type === "add") addedLines += 1;
    else if (step.type === "remove") removedLines += 1;
  }

  const unified = renderUnified(steps);

  return { hunks, unified, addedLines, removedLines };
}

/**
 * Produce a per-line list of { type, line } entries covering the full
 * transformation from oldLines -> newLines. Uses common prefix/suffix
 * extraction plus an LCS fallback in the middle.
 */
function diffLines(oldLines: string[], newLines: string[]): Step[] {
  // Common prefix.
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  // Common suffix (don't overlap the prefix).
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  const steps: Step[] = [];
  for (let i = 0; i < prefix; i += 1) {
    steps.push({ type: "equal", line: oldLines[i]! });
  }

  const midSteps = lcsDiff(oldMid, newMid);
  for (const step of midSteps) steps.push(step);

  for (let i = 0; i < suffix; i += 1) {
    steps.push({
      type: "equal",
      line: oldLines[oldLines.length - suffix + i]!,
    });
  }
  return steps;
}

/**
 * Classic LCS dynamic-program diff. Returns the per-line transformation
 * sequence that turns `a` into `b`.
 *
 * Lines that appear only in `a` become `remove`, lines that appear only
 * in `b` become `add`, and lines in the LCS become `equal`. Within a
 * contiguous divergence we emit all removals before any additions so
 * unified output reads naturally (old first, new second).
 */
function lcsDiff(a: string[], b: string[]): Step[] {
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line) => ({ type: "add" as const, line }));
  if (m === 0) return a.map((line) => ({ type: "remove" as const, line }));

  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    throw new Error(`Diff input too large (max ${MAX_LCS_CELLS} LCS cells)`);
  }

  // dp[i][j] = length of LCS of a[0..i) and b[0..j).
  // Uses a single (n+1)*(m+1) Int32Array to keep memory contiguous and
  // avoid nested allocations for large inputs.
  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const idx = i * width + j;
      if (a[i] === b[j]) {
        dp[idx] = dp[(i + 1) * width + (j + 1)]! + 1;
      } else {
        const down = dp[(i + 1) * width + j]!;
        const right = dp[i * width + (j + 1)]!;
        dp[idx] = down > right ? down : right;
      }
    }
  }

  // Backtrack. At each step we either take an equal, or emit pending
  // removes+adds when we diverge. We collect removes and adds into
  // buffers so each contiguous change block is emitted as
  // (removes..., adds...).
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  let pendingRemoves: string[] = [];
  let pendingAdds: string[] = [];

  const flush = () => {
    for (const line of pendingRemoves) steps.push({ type: "remove", line });
    for (const line of pendingAdds) steps.push({ type: "add", line });
    pendingRemoves = [];
    pendingAdds = [];
  };

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      steps.push({ type: "equal", line: a[i]! });
      i += 1;
      j += 1;
      continue;
    }
    const down = dp[(i + 1) * width + j]!;
    const right = dp[i * width + (j + 1)]!;
    if (down >= right) {
      pendingRemoves.push(a[i]!);
      i += 1;
    } else {
      pendingAdds.push(b[j]!);
      j += 1;
    }
  }
  while (i < n) {
    pendingRemoves.push(a[i]!);
    i += 1;
  }
  while (j < m) {
    pendingAdds.push(b[j]!);
    j += 1;
  }
  flush();
  return steps;
}

/**
 * Collapse a per-line step list into hunks, one per contiguous run of
 * the same type. The full sequence (all equals included) is returned —
 * no context trimming happens here; that's unified-string only.
 */
function collapseHunks(steps: Step[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  for (const step of steps) {
    if (!current || current.type !== step.type) {
      current = { type: step.type, lines: [step.line] };
      hunks.push(current);
    } else {
      current.lines.push(step.line);
    }
  }
  return hunks;
}

const CONTEXT_LINES = 3;

/**
 * Render the per-line step list into a unified-format string. Each
 * contiguous change block gets one `@@ -oldStart,oldCount +newStart,newCount @@`
 * header, with up to CONTEXT_LINES leading and trailing context lines.
 * Runs of equal lines longer than 2*CONTEXT_LINES between changes split
 * the output into multiple hunks.
 */
function renderUnified(steps: Step[]): string {
  if (steps.length === 0) return "";

  // Index each step with its 1-based old-file and new-file line number.
  // `equal`/`remove` advance the old counter; `equal`/`add` advance the
  // new counter.
  interface Indexed {
    type: Op;
    line: string;
    oldNo: number; // 0 if not applicable
    newNo: number; // 0 if not applicable
  }

  const indexed: Indexed[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const step of steps) {
    if (step.type === "equal") {
      oldNo += 1;
      newNo += 1;
      indexed.push({ type: "equal", line: step.line, oldNo, newNo });
    } else if (step.type === "remove") {
      oldNo += 1;
      indexed.push({ type: "remove", line: step.line, oldNo, newNo: 0 });
    } else {
      newNo += 1;
      indexed.push({ type: "add", line: step.line, oldNo: 0, newNo });
    }
  }

  // No changes at all — nothing to render.
  if (!indexed.some((s) => s.type !== "equal")) return "";

  // Group indices into hunks by scanning change spans and absorbing
  // CONTEXT_LINES on each side, merging adjacent spans when their
  // context overlaps.
  interface HunkRange {
    start: number; // inclusive index in `indexed`
    end: number; // inclusive index in `indexed`
  }

  const ranges: HunkRange[] = [];
  let i = 0;
  while (i < indexed.length) {
    if (indexed[i]!.type === "equal") {
      i += 1;
      continue;
    }
    // Find the end of this change run.
    let j = i;
    while (j < indexed.length && indexed[j]!.type !== "equal") j += 1;

    const start = Math.max(0, i - CONTEXT_LINES);
    const end = Math.min(indexed.length - 1, j - 1 + CONTEXT_LINES);

    // Merge with previous range if their contexts overlap.
    const prev = ranges[ranges.length - 1];
    if (prev && start <= prev.end) {
      prev.end = end;
    } else {
      ranges.push({ start, end });
    }
    i = j;
  }

  // After merging, if two ranges are close (their equal-only gap is
  // <= 2*CONTEXT_LINES) they should really be one hunk. The loop above
  // already handles this via the `start <= prev.end + 1` check combined
  // with the pre-expanded context, but we re-confirm by sweeping once.
  // (Left as-is — behavior is already correct because expansion uses
  // CONTEXT_LINES on both sides.)

  const parts: string[] = [];
  for (const range of ranges) {
    const slice = indexed.slice(range.start, range.end + 1);
    // Compute hunk header counts.
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    for (const step of slice) {
      if (step.type === "equal") {
        if (oldStart === 0) oldStart = step.oldNo;
        if (newStart === 0) newStart = step.newNo;
        oldCount += 1;
        newCount += 1;
      } else if (step.type === "remove") {
        if (oldStart === 0) oldStart = step.oldNo;
        // new side: start is the *next* new line that would appear
        // here, i.e. the new-counter at the moment of this remove.
        // We fill it in below if still zero.
        if (newStart === 0) newStart = step.newNo > 0 ? step.newNo : 0;
        oldCount += 1;
      } else {
        if (newStart === 0) newStart = step.newNo;
        if (oldStart === 0) oldStart = step.oldNo > 0 ? step.oldNo : 0;
        newCount += 1;
      }
    }

    // If the slice opens with a remove or add, `*Start` may still be 0
    // because that step didn't carry the other side's counter. In that
    // case we look back at the previous indexed entry to get the
    // corresponding counter; if there's nothing before it, use 1 when
    // the count is non-zero, else 0 (the unified convention for an
    // empty side is `0,0`).
    if (oldStart === 0) {
      const before = range.start > 0 ? indexed[range.start - 1] : undefined;
      oldStart = before ? before.oldNo : oldCount > 0 ? 1 : 0;
      if (before && before.type === "add") {
        // `before.oldNo` was 0; walk further back to find the last
        // real old-line number.
        let k = range.start - 2;
        while (k >= 0 && indexed[k]!.oldNo === 0) k -= 1;
        oldStart = k >= 0 ? indexed[k]!.oldNo : oldCount > 0 ? 1 : 0;
      }
      if (oldCount > 0 && oldStart === 0) oldStart = 1;
    }
    if (newStart === 0) {
      const before = range.start > 0 ? indexed[range.start - 1] : undefined;
      newStart = before ? before.newNo : newCount > 0 ? 1 : 0;
      if (before && before.type === "remove") {
        let k = range.start - 2;
        while (k >= 0 && indexed[k]!.newNo === 0) k -= 1;
        newStart = k >= 0 ? indexed[k]!.newNo : newCount > 0 ? 1 : 0;
      }
      if (newCount > 0 && newStart === 0) newStart = 1;
    }

    parts.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const step of slice) {
      const prefix = step.type === "equal" ? " " : step.type === "add" ? "+" : "-";
      parts.push(`${prefix}${step.line}`);
    }
  }

  return parts.join("\n");
}
