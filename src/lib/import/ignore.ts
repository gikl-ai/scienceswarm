const SKIP_IMPORT_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".hg",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "dist",
  "build",
  ".next",
  ".vercel",
  ".cache",
  ".eggs",
  "__MACOSX",
]);

const SKIP_IMPORT_FILE_NAMES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
]);

export function shouldSkipImportDirectory(name: string): boolean {
  return name.startsWith(".") || SKIP_IMPORT_DIR_NAMES.has(name);
}

export function shouldSkipImportFile(name: string): boolean {
  return name.startsWith(".") || SKIP_IMPORT_FILE_NAMES.has(name.toLowerCase());
}
