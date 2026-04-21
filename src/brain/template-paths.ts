/**
 * Resolve paths to files inside src/brain/ at runtime.
 *
 * Turbopack/Next.js server bundles rewrite `__dirname` to a stub path like
 * `/ROOT/src/brain`, which breaks filesystem reads of sibling template and
 * asset files. This helper tries the bundled `__dirname` path first and
 * falls back to resolving against `process.cwd()` when it does not exist.
 */

import { existsSync } from "fs";
import { resolve } from "path";

export function resolveBrainFile(...segments: string[]): string {
  const fromDirname = resolve(__dirname, ...segments);
  if (existsSync(fromDirname)) return fromDirname;

  const fromCwd = resolve(process.cwd(), "src", "brain", ...segments);
  if (existsSync(fromCwd)) return fromCwd;

  console.warn(
    `[resolveBrainFile] could not find ${JSON.stringify(segments)} relative to __dirname or process.cwd()/src/brain. Falling back to ${fromDirname}`,
  );
  return fromDirname;
}
