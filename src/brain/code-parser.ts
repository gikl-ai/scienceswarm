/**
 * Second Brain — Code Repository Parser
 *
 * Parses code directories and individual code files to extract metadata
 * for wiki page generation. Uses regex-based extraction (not AST) for
 * lightweight, dependency-free parsing of Python, R, and Julia code.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "fs";
import { join, extname, basename, relative } from "path";

// ── Types ────────────────────────────────────────────

export interface RepoMetadata {
  name: string;
  language: string;
  readme: string | null;
  structure: Array<{ path: string; type: "file" | "dir"; language?: string }>;
  entryPoints: string[];
  dependencies: string[];
  docstrings: Array<{ file: string; name: string; docstring: string }>;
  scripts: Array<{ name: string; description: string }>;
  testCount: number;
}

export interface CodeFileMetadata {
  path: string;
  language: string;
  docstring: string | null;
  functions: Array<{ name: string; docstring: string | null }>;
  classes: Array<{ name: string; docstring: string | null }>;
  imports: string[];
}

// ── Language detection ───────────────────────────────

const LANGUAGE_MAP: Record<string, string> = {
  ".py": "python",
  ".r": "r",
  ".R": "r",
  ".jl": "julia",
  ".js": "javascript",
  ".ts": "typescript",
  ".jsx": "javascript",
  ".tsx": "typescript",
  ".go": "go",
  ".rs": "rust",
  ".cpp": "cpp",
  ".c": "c",
  ".java": "java",
  ".sh": "shell",
  ".bash": "shell",
  ".rb": "ruby",
  ".m": "matlab",
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  ".env",
  "env",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".eggs",
  "dist",
  "build",
  ".ipynb_checkpoints",
  ".cache",
]);

// ── Public API ───────────────────────────────────────

/**
 * Scan a code directory and extract repository metadata.
 */
export function parseCodeRepo(dirPath: string): RepoMetadata {
  const name = basename(dirPath);

  // Read README
  const readme = readReadme(dirPath);

  // Walk the directory structure
  const structure: RepoMetadata["structure"] = [];
  const languageCounts = new Map<string, number>();
  let testCount = 0;

  walkCodeDir(dirPath, dirPath, (filePath, relPath, isDir) => {
    if (isDir) {
      structure.push({ path: relPath, type: "dir" });
      return;
    }

    const ext = extname(filePath);
    const lang = LANGUAGE_MAP[ext];
    structure.push({ path: relPath, type: "file", ...(lang ? { language: lang } : {}) });

    if (lang) {
      languageCounts.set(lang, (languageCounts.get(lang) ?? 0) + 1);
    }

    // Count test files
    const name = basename(filePath).toLowerCase();
    if (
      name.startsWith("test_") ||
      name.endsWith("_test.py") ||
      name.endsWith(".test.ts") ||
      name.endsWith(".test.js") ||
      name.endsWith(".spec.ts") ||
      name.endsWith(".spec.js") ||
      relPath.includes("tests/") ||
      relPath.includes("test/")
    ) {
      testCount++;
    }
  });

  // Detect primary language
  const language = detectPrimaryLanguage(languageCounts);

  // Extract entry points
  const entryPoints = detectEntryPoints(dirPath, structure);

  // Extract dependencies
  const dependencies = extractDependencies(dirPath);

  // Extract docstrings from Python files
  const docstrings = extractRepoDocstrings(dirPath, structure);

  // Extract scripts
  const scripts = detectScripts(dirPath, structure);

  return {
    name,
    language,
    readme,
    structure,
    entryPoints,
    dependencies,
    docstrings,
    scripts,
    testCount,
  };
}

/**
 * Parse a single code file and extract metadata.
 */
export function parseCodeFile(filePath: string): CodeFileMetadata {
  const ext = extname(filePath);
  const language = LANGUAGE_MAP[ext] ?? "unknown";
  const content = readFileSync(filePath, "utf-8");

  return parseCodeContent(content, filePath, language);
}

/**
 * Parse code content directly (useful for testing without files).
 */
export function parseCodeContent(
  content: string,
  path: string,
  language: string,
): CodeFileMetadata {
  if (language === "python") {
    return parsePythonContent(content, path);
  }

  // Generic fallback for other languages
  return {
    path,
    language,
    docstring: null,
    functions: [],
    classes: [],
    imports: extractGenericImports(content, language),
  };
}

// ── Internal: Directory Walking ──────────────────────

function walkCodeDir(
  rootDir: string,
  currentDir: string,
  callback: (filePath: string, relPath: string, isDir: boolean) => void,
): void {
  let entries: string[];
  try {
    entries = readdirSync(currentDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith(".") && entry !== ".gitignore") continue;
    if (SKIP_DIRS.has(entry)) continue;

    const fullPath = join(currentDir, entry);
    const relPath = relative(rootDir, fullPath);

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        callback(fullPath, relPath, true);
        walkCodeDir(rootDir, fullPath, callback);
      } else {
        callback(fullPath, relPath, false);
      }
    } catch {
      // Skip inaccessible entries
    }
  }
}

function readReadme(dirPath: string): string | null {
  const candidates = [
    "README.md",
    "readme.md",
    "README.rst",
    "README.txt",
    "README",
  ];
  for (const name of candidates) {
    const p = join(dirPath, name);
    if (existsSync(p)) {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ── Internal: Language Detection ─────────────────────

function detectPrimaryLanguage(counts: Map<string, number>): string {
  if (counts.size === 0) return "unknown";
  let maxLang = "unknown";
  let maxCount = 0;
  for (const [lang, count] of counts) {
    if (count > maxCount) {
      maxLang = lang;
      maxCount = count;
    }
  }
  return maxLang;
}

// ── Internal: Entry Points ──────────────────────────

function detectEntryPoints(
  dirPath: string,
  structure: RepoMetadata["structure"],
): string[] {
  const entryPointNames = [
    "main.py",
    "__main__.py",
    "app.py",
    "run.py",
    "setup.py",
    "manage.py",
    "Makefile",
    "index.js",
    "index.ts",
    "main.go",
    "main.rs",
  ];

  const entryPoints: string[] = [];

  for (const item of structure) {
    if (item.type !== "file") continue;
    const name = basename(item.path);
    if (entryPointNames.includes(name)) {
      entryPoints.push(item.path);
    }
  }

  // Also check for setup.cfg, pyproject.toml, package.json at root
  for (const f of ["setup.cfg", "pyproject.toml", "package.json"]) {
    if (existsSync(join(dirPath, f))) {
      if (!entryPoints.includes(f)) {
        entryPoints.push(f);
      }
    }
  }

  return entryPoints;
}

// ── Internal: Dependencies ──────────────────────────

function extractDependencies(dirPath: string): string[] {
  const deps = new Set<string>();

  // requirements.txt
  const reqPath = join(dirPath, "requirements.txt");
  if (existsSync(reqPath)) {
    try {
      const content = readFileSync(reqPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
        // Parse "package>=1.0" -> "package"
        const pkgMatch = trimmed.match(/^([a-zA-Z0-9_-]+)/);
        if (pkgMatch) deps.add(pkgMatch[1]);
      }
    } catch {
      // skip
    }
  }

  // setup.py — extract install_requires
  const setupPath = join(dirPath, "setup.py");
  if (existsSync(setupPath)) {
    try {
      const content = readFileSync(setupPath, "utf-8");
      const reqMatch = content.match(
        /install_requires\s*=\s*\[([\s\S]*?)\]/,
      );
      if (reqMatch) {
        for (const match of reqMatch[1].matchAll(/["']([a-zA-Z0-9_-]+)/g)) {
          deps.add(match[1]);
        }
      }
    } catch {
      // skip
    }
  }

  // pyproject.toml — extract dependencies
  const pyprojectPath = join(dirPath, "pyproject.toml");
  if (existsSync(pyprojectPath)) {
    try {
      const content = readFileSync(pyprojectPath, "utf-8");
      const depSection = content.match(
        /\[(?:project\.)?dependencies\]\s*\n([\s\S]*?)(?:\n\[|$)/,
      );
      if (depSection) {
        for (const match of depSection[1].matchAll(/["']([a-zA-Z0-9_-]+)/g)) {
          deps.add(match[1]);
        }
      }
      // Also try the array format: dependencies = ["pkg1", "pkg2"]
      const depArray = content.match(
        /dependencies\s*=\s*\[([\s\S]*?)\]/,
      );
      if (depArray) {
        for (const match of depArray[1].matchAll(/["']([a-zA-Z0-9_-]+)/g)) {
          deps.add(match[1]);
        }
      }
    } catch {
      // skip
    }
  }

  // package.json
  const pkgPath = join(dirPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const content = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (content.dependencies) {
        for (const name of Object.keys(content.dependencies)) {
          deps.add(name);
        }
      }
      if (content.devDependencies) {
        for (const name of Object.keys(content.devDependencies)) {
          deps.add(name);
        }
      }
    } catch {
      // skip
    }
  }

  return [...deps].sort();
}

// ── Internal: Docstrings ────────────────────────────

function extractRepoDocstrings(
  dirPath: string,
  structure: RepoMetadata["structure"],
): RepoMetadata["docstrings"] {
  const docstrings: RepoMetadata["docstrings"] = [];

  for (const item of structure) {
    if (item.type !== "file" || item.language !== "python") continue;
    const filePath = join(dirPath, item.path);

    try {
      const content = readFileSync(filePath, "utf-8");
      const parsed = parsePythonContent(content, item.path);

      // Add module docstring
      if (parsed.docstring) {
        docstrings.push({
          file: item.path,
          name: basename(item.path, ".py"),
          docstring: parsed.docstring,
        });
      }

      // Add function/class docstrings
      for (const fn of parsed.functions) {
        if (fn.docstring) {
          docstrings.push({
            file: item.path,
            name: fn.name,
            docstring: fn.docstring,
          });
        }
      }
      for (const cls of parsed.classes) {
        if (cls.docstring) {
          docstrings.push({
            file: item.path,
            name: cls.name,
            docstring: cls.docstring,
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return docstrings;
}

// ── Internal: Scripts ───────────────────────────────

function detectScripts(
  dirPath: string,
  structure: RepoMetadata["structure"],
): RepoMetadata["scripts"] {
  const scripts: RepoMetadata["scripts"] = [];

  // Check Makefile targets
  const makefilePath = join(dirPath, "Makefile");
  if (existsSync(makefilePath)) {
    try {
      const content = readFileSync(makefilePath, "utf-8");
      // Extract targets with optional comments above them
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const targetMatch = lines[i].match(/^([a-zA-Z_][\w-]*):/);
        if (targetMatch) {
          // Check for comment on the line above
          const desc =
            i > 0 && lines[i - 1].startsWith("#")
              ? lines[i - 1].replace(/^#\s*/, "").trim()
              : `make ${targetMatch[1]}`;
          scripts.push({
            name: `make ${targetMatch[1]}`,
            description: desc,
          });
        }
      }
    } catch {
      // skip
    }
  }

  // Check scripts/ directory
  for (const item of structure) {
    if (
      item.type === "file" &&
      (item.path.startsWith("scripts/") || item.path.startsWith("bin/"))
    ) {
      scripts.push({
        name: basename(item.path),
        description: `Script: ${item.path}`,
      });
    }
  }

  return scripts;
}

// ── Internal: Python Parsing ────────────────────────

function parsePythonContent(
  content: string,
  path: string,
): CodeFileMetadata {
  const imports: string[] = [];
  const functions: Array<{ name: string; docstring: string | null }> = [];
  const classes: Array<{ name: string; docstring: string | null }> = [];

  // Extract imports
  for (const match of content.matchAll(/^\s*import\s+([\w.]+)/gm)) {
    imports.push(match[1].split(".")[0]);
  }
  for (const match of content.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) {
    imports.push(match[1].split(".")[0]);
  }

  // Extract module docstring (first triple-quoted string at top of file)
  const moduleDocstring = extractPythonDocstring(content);

  // Extract function definitions with docstrings
  for (const match of content.matchAll(/^[ \t]*def\s+(\w+)\s*\([^)]*\)[^:]*:/gm)) {
    const name = match[1];
    const afterDef = content.slice(match.index! + match[0].length);
    const docstring = extractPythonDocstring(afterDef);
    functions.push({ name, docstring });
  }

  // Extract class definitions with docstrings
  for (const match of content.matchAll(/^[ \t]*class\s+(\w+)[^:]*:/gm)) {
    const name = match[1];
    const afterDef = content.slice(match.index! + match[0].length);
    const docstring = extractPythonDocstring(afterDef);
    classes.push({ name, docstring });
  }

  return {
    path,
    language: "python",
    docstring: moduleDocstring,
    functions,
    classes,
    imports: [...new Set(imports)],
  };
}

function extractPythonDocstring(content: string): string | null {
  // Look for triple-quoted string at the start (after whitespace/newlines)
  const match = content.match(/^\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? "").trim();
  // Return first 500 chars
  return raw.slice(0, 500) || null;
}

function extractGenericImports(content: string, language: string): string[] {
  const imports: string[] = [];

  if (language === "r") {
    for (const match of content.matchAll(
      /(?:library|require)\s*\(\s*["']?(\w+)["']?\s*\)/gm,
    )) {
      imports.push(match[1]);
    }
  } else if (language === "julia") {
    for (const match of content.matchAll(
      /^\s*(?:using|import)\s+([\w.]+)/gm,
    )) {
      imports.push(match[1].split(".")[0]);
    }
  } else if (language === "javascript" || language === "typescript") {
    for (const match of content.matchAll(
      /(?:import|require)\s*\(?["']([^"']+)["']\)?/gm,
    )) {
      imports.push(match[1]);
    }
  }

  return [...new Set(imports)];
}
