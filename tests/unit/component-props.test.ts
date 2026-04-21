/**
 * Component Props Integrity Test
 *
 * Catches "X is not defined" ReferenceErrors by scanning all
 * component files for identifiers that appear in JSX but aren't
 * defined anywhere in the file (not imported, not declared, not a prop).
 *
 * This test would have caught:
 * - "sampleFiles is not defined"
 * - "uploadProgress is not defined"
 * - "onImportLocalProject is not defined"
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const COMPONENT_DIRS = [
  "src/components/research",
  "src/app",
];

const RESERVED_JSX_LITERALS = new Set(["true", "false", "null", "undefined"]);

function getComponentFiles(): string[] {
  const files: string[] = [];
  for (const dir of COMPONENT_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".tsx")) files.push(full);
      }
    };
    walk(dir);
  }
  return files;
}

function findTopLevelJSXIdentifiers(content: string): Array<{ id: string; line: number }> {
  const results: Array<{ id: string; line: number }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Look for patterns that would crash at runtime:
    // {someVar && ...} or {someVar.prop} or prop={someVar}
    // These need someVar to be defined in scope

    // Pattern: {identifier && or {identifier ||
    for (const m of line.matchAll(/\{\s*([a-z]\w*)\s*(?:&&|\|\|)/g)) {
      results.push({ id: m[1], line: i + 1 });
    }

    // Pattern: {identifier.something
    for (const m of line.matchAll(/\{\s*([a-z]\w*)\./g)) {
      results.push({ id: m[1], line: i + 1 });
    }

    // Pattern: prop={identifier} — JSX prop referencing a variable
    for (const m of line.matchAll(/\w+=\{\s*([a-z]\w*)\s*\}/g)) {
      results.push({ id: m[1], line: i + 1 });
    }
  }

  return results;
}

describe("Component Props Integrity — no undefined references", () => {
  const files = getComponentFiles();

  it("finds component files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const filePath of files) {
    it(`${path.relative(".", filePath)}: no undefined top-level identifiers`, () => {
      const content = fs.readFileSync(filePath, "utf-8");

      // Strip comments first so both reference extraction AND definition checks
      // operate on the same comment-free content (avoids false positives from
      // commented-out JSX like `// {uploadProgress && <ProgressBar />}`)
      const strippedContent = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

      // Get identifiers used in JSX that need to be defined
      const jsxRefs = findTopLevelJSXIdentifiers(strippedContent);

      const problems: string[] = [];

      for (const ref of jsxRefs) {
        if (RESERVED_JSX_LITERALS.has(ref.id)) {
          continue;
        }

        // Check: is this identifier defined ANYWHERE in the file?
        // If it appears in a const, let, var, import, function, or param — it's fine.
        // We check if it appears in a definition context, not just as a reference.

        const defPatterns = [
          new RegExp(`(?:const|let|var)\\s+${ref.id}\\b`),           // const foo
          new RegExp(`(?:const|let|var)\\s+\\{[^}]*\\b${ref.id}\\b`), // const { foo }
          new RegExp(`(?:const|let|var)\\s+\\[[^\\]]*\\b${ref.id}\\b`), // const [foo]
          new RegExp(`function\\s+${ref.id}\\b`),                     // function foo
          new RegExp(`import\\s+${ref.id}\\b`),                       // import foo
          new RegExp(`import\\s+\\{[^}]*\\b${ref.id}\\b`),           // import { foo }
          new RegExp(`\\(\\s*\\{[^}]*\\b${ref.id}\\b[^}]*\\}\\s*[:\\)]`), // ({ foo }: Props) or ({ foo })
          new RegExp(`\\(\\s*${ref.id}\\s*[,:\\)]`),                  // (foo, ...) or (foo: Type)
          new RegExp(`(?:async\\s*)?\\(\\s*[^)]*\\b${ref.id}\\b[^)]*\\)\\s*=>`), // (foo) =>, ({ foo }) =>, ([key, foo]) =>
          new RegExp(`(?:async\\s*)?\\b${ref.id}\\b\\s*=>`),          // foo =>
        ];

        const isDefined = defPatterns.some(p => p.test(strippedContent));

        if (!isDefined) {
          problems.push(`Line ${ref.line}: "${ref.id}" used in JSX but never defined (const, let, import, or prop)`);
        }
      }

      expect(problems).toEqual([]);
    });
  }
});
