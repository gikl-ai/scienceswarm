/**
 * gbrain-init install task — adapts the existing gbrain-installer
 * generator to the bootstrap orchestrator's event contract.
 */

import {
  runInstaller,
  defaultInstallerEnvironment,
  type InstallError,
} from "@/lib/setup/gbrain-installer";
import { initBrain } from "@/brain/init";
import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";
import type { InstallTask, TaskYield } from "./types";

export const gbrainInitTask: InstallTask = {
  id: "gbrain-init",
  async *run(input) {
    yield { status: "running", detail: "Initializing PGLite + schema…" };
    const env = await defaultInstallerEnvironment();
    // Resolve the brain root through the canonical resolver so
    // SCIENCESWARM_DIR and BRAIN_ROOT are honored. Without this, the
    // gbrain installer's built-in default is `$HOME/.scienceswarm/brain`,
    // which ignores SCIENCESWARM_DIR and silently leaks state into the
    // user's real dotdir even when they ran with an override.
    const brainRoot = getScienceSwarmBrainRoot();
    let failure: TaskYield | null = null;
    for await (const event of runInstaller(
      { repoRoot: input.repoRoot, brainRoot, skipNetworkCheck: true },
      env,
    )) {
      if (event.type === "step" && event.status === "failed" && event.error) {
        failure = { status: "failed", error: formatInstallError(event.error) };
      }
      if (event.type === "summary" && event.status === "failed") {
        failure = {
          status: "failed",
          error: event.error
            ? formatInstallError(event.error)
            : "gbrain init failed",
        };
      }
    }
    if (failure) {
      yield failure;
      return;
    }
    try {
      initBrain({
        root: brainRoot,
        name: input.handle,
      });
    } catch (err) {
      yield {
        status: "failed",
        error:
          err instanceof Error
            ? err.message
            : "gbrain brain scaffold initialization failed",
      };
      return;
    }
    yield {
      status: "succeeded",
      detail: "Local research store initialized. Import data next to build your brain.",
    };
  },
};

function formatInstallError(error: InstallError): string {
  const parts = [error.message];
  if (error.cause) parts.push(`Cause: ${error.cause}`);
  if (error.recovery) parts.push(`Recovery: ${error.recovery}`);
  return parts.join(" ");
}
