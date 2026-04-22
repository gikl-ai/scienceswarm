import { existsSync } from "node:fs";
import { join } from "node:path";

export function hasGbrainMetadata(root: string): boolean {
  return existsSync(join(root, "BRAIN.md")) || existsSync(join(root, "RESOLVER.md"));
}

export function isGbrainRootReady(root: string): boolean {
  return existsSync(root) && hasGbrainMetadata(root) && existsSync(join(root, "brain.pglite"));
}
