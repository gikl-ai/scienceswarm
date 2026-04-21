export interface OrganizedFile {
  originalName: string;
  organizedPath: string;
  category: string;
}

interface OrganizeRule {
  category: string;
  folder: string;
  extensions: string[];
  testPattern?: RegExp;
}

const ORGANIZE_RULES: OrganizeRule[] = [
  { category: "tests", folder: "code/tests", extensions: ["py", "ts", "js"], testPattern: /^test_|_test\.|\.test\.|\.spec\./ },
  { category: "papers", folder: "papers", extensions: ["pdf"] },
  { category: "code", folder: "code", extensions: ["py", "r", "jl", "m", "ipynb", "rb", "go", "rs", "c", "cpp", "h", "java", "scala"] },
  { category: "data", folder: "data", extensions: ["csv", "json", "tsv", "xlsx", "xls", "npy", "npz", "h5", "hdf5", "parquet", "pkl", "pickle", "dat", "feather"] },
  { category: "docs", folder: "docs", extensions: ["tex", "bib", "md", "txt", "rst", "docx", "doc"] },
  { category: "figures", folder: "figures", extensions: ["png", "jpg", "jpeg", "svg", "gif", "webp", "eps", "tiff"] },
  { category: "config", folder: "config", extensions: ["yaml", "yml", "toml", "ini", "cfg", "env"] },
];

/** Known top-level folder names that indicate the files are already organized. */
const KNOWN_FOLDERS = new Set(["papers", "code", "data", "docs", "figures", "config", "tests"]);

/**
 * Detect whether an uploaded set of files already uses a recognised folder
 * structure (e.g. `papers/foo.pdf`, `code/bar.py`). When true the caller
 * should skip re-organisation and preserve the existing layout.
 */
export function isAlreadyOrganized(files: Array<{ path?: string }>): boolean {
  const withPaths = files.filter((f) => f.path && f.path.includes("/"));
  if (withPaths.length === 0) return false;

  let matchCount = 0;
  for (const f of withPaths) {
    const topFolder = (f.path as string).split("/")[0].toLowerCase();
    if (KNOWN_FOLDERS.has(topFolder)) matchCount++;
  }

  // Consider already-organised if at least half the files with paths live
  // under a recognised top-level folder.
  return matchCount / withPaths.length >= 0.5;
}

function getExtension(name: string): string {
  const parts = name.split(".");
  return parts.length > 1 ? (parts.pop() as string).toLowerCase() : "";
}

function looksLikeAcademicPdf(content?: string): boolean {
  if (!content) return true; // Default PDFs to papers
  const lower = content.toLowerCase();
  const indicators = ["abstract", "references", "theorem", "lemma", "proof", "introduction", "methodology"];
  return indicators.some((kw) => lower.includes(kw));
}

function looksLikeFigurePdf(name: string, content?: string): boolean {
  const lower = name.toLowerCase();
  const figureKeywords = ["figure", "poster", "slide", "diagram", "chart", "plot"];
  if (figureKeywords.some((kw) => lower.includes(kw))) return true;
  if (content) {
    const cl = content.toLowerCase();
    if (cl.includes("slide") || cl.includes("poster")) return true;
  }
  return false;
}

/**
 * Organise a flat list of files into a clean folder structure based on file
 * extension and naming conventions.
 */
export function organizeFiles(
  files: Array<{ name: string; path?: string; content?: string }>,
): OrganizedFile[] {
  // If the files already have a recognised structure, preserve it.
  if (isAlreadyOrganized(files)) {
    return files.map((f) => ({
      originalName: f.name,
      organizedPath: f.path || f.name,
      category: categorize(f.name, f.path, f.content),
    }));
  }

  return files.map((f) => {
    const category = categorize(f.name, f.path, f.content);

    // Determine target folder based on category.
    let folder: string;
    switch (category) {
      case "tests":
        folder = "code/tests";
        break;
      case "papers":
        folder = "papers";
        break;
      case "code":
        folder = "code";
        break;
      case "data":
        folder = "data";
        break;
      case "docs":
        folder = "docs";
        break;
      case "figures":
        folder = "figures";
        break;
      case "config":
        folder = "config";
        break;
      default:
        folder = "other";
    }

    return {
      originalName: f.name,
      organizedPath: `${folder}/${f.name}`,
      category,
    };
  });
}

function categorize(name: string, path?: string, content?: string): string {
  const ext = getExtension(name);

  // Check test pattern first (must come before generic code match).
  const testRule = ORGANIZE_RULES.find((r) => r.category === "tests");
  if (testRule && testRule.testPattern && testRule.extensions.includes(ext) && testRule.testPattern.test(name)) {
    return "tests";
  }

  // Special PDF handling.
  if (ext === "pdf") {
    if (looksLikeFigurePdf(name, content)) return "figures";
    if (looksLikeAcademicPdf(content)) return "papers";
    return "docs";
  }

  // Match by extension against remaining rules (skip tests, already handled).
  for (const rule of ORGANIZE_RULES) {
    if (rule.category === "tests") continue;
    if (rule.extensions.includes(ext)) return rule.category;
  }

  return "other";
}

/**
 * Build a summary string for a set of organised files.
 * E.g. "Auto-organized into 4 folders"
 */
export function organizeSummary(organized: OrganizedFile[]): string {
  const folders = new Set(organized.map((f) => f.organizedPath.split("/")[0]));
  return `Auto-organized into ${folders.size} folder${folders.size === 1 ? "" : "s"}`;
}
