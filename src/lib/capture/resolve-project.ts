import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  listProjectManifests,
  readProjectManifest,
} from "@/lib/state/project-manifests";
import { isDefaultGlobalStateRoot } from "@/lib/state/project-storage";
import type { ProjectResolution } from "./types";

async function listActiveProjectSlugs(stateRoot: string): Promise<string[]> {
  if (!isDefaultGlobalStateRoot(stateRoot)) {
    const projectsDir = join(stateRoot, "projects");
    try {
      await access(projectsDir, constants.F_OK);
    } catch {
      return [];
    }

    const entries = await readdir(projectsDir, { withFileTypes: true });
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => readProjectManifest(entry.name, stateRoot)),
    );

    return manifests
      .filter((manifest): manifest is NonNullable<typeof manifest> => Boolean(manifest && manifest.status !== "archived"))
      .map((manifest) => manifest.slug)
      .sort();
  }

  const manifests = await listProjectManifests();
  return manifests
    .filter((manifest) => manifest.status !== "archived")
    .map((manifest) => manifest.slug)
    .sort();
}

export async function resolveProject(input: {
  stateRoot: string;
  explicitProject?: string | null;
  sessionActiveProject?: string | null;
}): Promise<ProjectResolution> {
  if (input.explicitProject?.trim()) {
    return {
      project: input.explicitProject.trim(),
      source: "explicit",
      choices: [],
    };
  }

  if (input.sessionActiveProject?.trim()) {
    return {
      project: input.sessionActiveProject.trim(),
      source: "session",
      choices: [],
    };
  }

  const candidates = await listActiveProjectSlugs(input.stateRoot);
  if (candidates.length === 1) {
    return {
      project: candidates[0],
      source: "single-project",
      choices: candidates,
    };
  }

  return {
    project: null,
    source: "ambiguous",
    choices: candidates,
    clarificationQuestion: candidates.length > 1
      ? "Which project should this capture belong to?"
      : "Which project should I link this capture to?",
  };
}
