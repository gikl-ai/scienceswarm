/**
 * connect-gbrain — Initialize the research brain.
 *
 * With PGLite, there is no external database to validate.
 * This module creates wiki scaffolding and resets the store singleton.
 */

import { getScienceSwarmBrainRoot, resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import { initBrain } from "./init";
import { ensureBrainStoreReady, resetBrainStore } from "./store";

export interface ConnectResult {
  success: boolean;
  message: string;
  brainRoot?: string;
  wikiCreated?: boolean;
}

function resolveBrainRoot(): string {
  return (
    resolveConfiguredPath(process.env.BRAIN_ROOT) ??
    getScienceSwarmBrainRoot()
  );
}

export async function connectGbrain(
  _projectRoot?: string,
): Promise<ConnectResult> {
  const brainRoot = resolveBrainRoot();
  try {
    await resetBrainStore();
    const initResult = initBrain({ root: brainRoot });
    await ensureBrainStoreReady();

    return {
      success: true,
      message: initResult.created
        ? `Research brain created at ${brainRoot}.`
        : `Research brain already exists at ${brainRoot}.`,
      brainRoot,
      wikiCreated: initResult.created,
    };
  } catch (error) {
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Brain initialization failed",
      brainRoot,
    };
  }
}
