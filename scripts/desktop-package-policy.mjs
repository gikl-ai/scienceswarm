import path from "node:path";

export const FORBIDDEN_DESKTOP_PACKAGE_SEGMENTS = new Set([
  ".claude",
  ".codex",
  ".gemini",
  ".git",
  ".github",
  ".local",
  ".worktrees",
  "blobs",
  "manifests",
  "ollama-models",
  "test",
  "tests",
]);

export function normalizePackagePath(filePath) {
  return filePath.split(path.sep).join("/");
}

export function isForbiddenDesktopPackageRelativePath(
  relativePath,
  { standaloneRoot = false } = {},
) {
  const normalizedPath = normalizePackagePath(relativePath);
  const segments = normalizedPath.split("/");
  const basename = segments.at(-1) ?? "";
  const standalonePrefix = ".next/standalone/";
  const standaloneRelativePath = standaloneRoot
    ? normalizedPath
    : normalizedPath.startsWith(standalonePrefix)
      ? normalizedPath.slice(standalonePrefix.length)
      : null;

  return (
    normalizedPath.endsWith(".gguf")
    || basename === ".env"
    || basename.startsWith(".env.")
    || (
      standaloneRelativePath != null
      && !standaloneRelativePath.includes("/")
      && standaloneRelativePath.endsWith(".md")
    )
    || segments.some((segment) => FORBIDDEN_DESKTOP_PACKAGE_SEGMENTS.has(segment))
  );
}
