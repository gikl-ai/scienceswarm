/**
 * require-attribution
 *
 * ScienceSwarm custom ESLint rule that enforces attributed gbrain
 * writes: any file under `src/` that writes to gbrain via `putPage`,
 * `upsertChunks`, or `addTimelineEntry` must also import
 * `getCurrentUserHandle` from `@/lib/setup/gbrain-installer` so the
 * write path threads a real ScienceSwarm user handle. Unattributed
 * writes are forbidden — the installer helper throws loudly when
 * `SCIENCESWARM_USER_HANDLE` is unset, which is the whole point.
 *
 * Scope: this rule is **presence-only**, not usage-verified. It
 * checks that the helper is imported in the same file as the write
 * call — it does *not* prove that `getCurrentUserHandle()` is
 * actually called or that its return value is threaded into the
 * write. A file that imports the helper and never uses it will
 * silently pass. That is a deliberate trade-off: the rule exists as
 * a regression-gate against the failure mode caught on a prior review
 * (new write sites that simply forget about attribution), not as
 * a full data-flow analysis. Reviewer responsibility still lives on
 * top of the rule — it raises the floor, it does not set the ceiling.
 */

const TARGET_METHODS = new Set([
  "putPage",
  "upsertChunks",
  "addTimelineEntry",
]);

// The alias matcher is tightly anchored because `@/` imports always
// resolve through tsconfig paths to a single canonical location.
// The relative matcher is intentionally looser — it accepts any
// relative path whose last segment is `gbrain-installer[.ext]` — to
// cover intra-`src/lib/setup/` imports like `../setup/gbrain-installer`
// that legitimately reach the installer without going through the
// `@/` alias. Because the rule is only wired for files under `src/`
// (see `eslint.config.mjs`), any relative path that lands on the
// installer's filename is by construction reaching the real helper,
// not a user-supplied impostor.
const INSTALLER_SOURCE_PATTERN = /(^|\/)gbrain-installer(\.(ts|js|mjs|cjs))?$/;
const INSTALLER_ALIAS_PATTERN = /^@\/lib\/setup\/gbrain-installer$/;

function matchesInstallerSource(source) {
  if (typeof source !== "string") return false;
  if (INSTALLER_ALIAS_PATTERN.test(source)) return true;
  return INSTALLER_SOURCE_PATTERN.test(source);
}

const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `getCurrentUserHandle` import in files that write to gbrain",
    },
    messages: {
      missing:
        "Write site `{{method}}` must thread `getCurrentUserHandle()` from `@/lib/setup/gbrain-installer` so gbrain writes stay attributed to a real ScienceSwarm user handle.",
    },
    schema: [],
  },
  create(context) {
    let hasImport = false;
    const flagged = [];

    return {
      ImportDeclaration(node) {
        if (!matchesInstallerSource(node.source && node.source.value)) {
          return;
        }
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === "getCurrentUserHandle"
          ) {
            hasImport = true;
            break;
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== "MemberExpression") return;
        const prop = callee.property;
        if (!prop || prop.type !== "Identifier") return;
        if (!TARGET_METHODS.has(prop.name)) return;
        flagged.push({ node, method: prop.name });
      },
      "Program:exit"() {
        if (hasImport) return;
        for (const entry of flagged) {
          context.report({
            node: entry.node,
            messageId: "missing",
            data: { method: entry.method },
          });
        }
      },
    };
  },
};

export default rule;
