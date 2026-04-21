/**
 * OpenHands code-execution readiness task.
 *
 * OpenHands is optional during first-run onboarding: local chat, gbrain,
 * and the import workspace are still useful without Docker. The task is
 * therefore intentionally non-blocking:
 *
 * - If Docker is unavailable or still starting, we surface a `skipped`
 *   state with an actionable recovery detail.
 * - If Docker is ready, we mark the capability ready quickly and let the
 *   runtime provision the image on first use instead of holding the whole
 *   setup flow on a large pull.
 */

import type { InstallTask, TaskYield } from "./types";
import {
  cleanProcessOutput,
  resolveExecutable,
  runCommand,
  sleep,
  which,
} from "./runtime-helpers";

const DOCKER_START_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(
    process.env.OPENHANDS_DOCKER_START_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15_000;
})();
const DOCKER_POLL_INTERVAL_MS = 2_000;

const DOCKER_CLI_CANDIDATES = [
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/usr/bin/docker",
];

async function resolveDockerCli(): Promise<string | null> {
  return resolveExecutable("docker", DOCKER_CLI_CANDIDATES);
}

async function dockerInfo(
  dockerCli: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await runCommand(dockerCli, ["info"], {
    maxOutputChars: 8_000,
  });
  return {
    ok: result.ok,
    error: cleanProcessOutput(result.stderr || result.stdout),
  };
}

async function startDocker(): Promise<void> {
  if (process.platform === "darwin") {
    await runCommand("open", ["-ga", "Docker"], { maxOutputChars: 4_000 });
    return;
  }

  if (process.platform === "linux") {
    const systemctl = await which("systemctl");
    const sudo = await which("sudo");
    if (systemctl) {
      const result = await runCommand(systemctl, ["start", "docker"], {
        maxOutputChars: 4_000,
      });
      if (result.ok) return;
      if (sudo) {
        const sudoResult = await runCommand(
          sudo,
          ["-n", systemctl, "start", "docker"],
          { maxOutputChars: 4_000 },
        );
        if (sudoResult.ok) return;
      }
    }
    const service = await which("service");
    if (service) {
      const result = await runCommand(service, ["docker", "start"], {
        maxOutputChars: 4_000,
      });
      if (result.ok) return;
      if (sudo) {
        await runCommand(sudo, ["-n", service, "docker", "start"], {
          maxOutputChars: 4_000,
        });
      }
    }
  }
}

async function* waitForDockerWithProgress(
  dockerCli: string,
  timeoutMs = DOCKER_START_TIMEOUT_MS,
): AsyncGenerator<TaskYield, { ok: boolean; error?: string }, unknown> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last: { ok: boolean; error?: string } = { ok: false };
  let nextProgressAt = startedAt;

  while (Date.now() <= deadline) {
    const now = Date.now();
    if (now >= nextProgressAt) {
      const elapsedSec = Math.max(0, Math.round((now - startedAt) / 1000));
      yield {
        status: "running",
        detail: `${startDockerDetail()} Waiting for Docker to become ready (${elapsedSec}s elapsed)…`,
      };
      nextProgressAt = now + 10_000;
    }

    last = await dockerInfo(dockerCli);
    if (last.ok) return last;
    await sleep(DOCKER_POLL_INTERVAL_MS);
  }
  return last;
}

function startDockerDetail(): string {
  if (process.platform === "darwin") return "Starting Docker Desktop…";
  if (process.platform === "linux") return "Starting Docker daemon…";
  return "Starting Docker…";
}

function dockerRecoveryHint(): string {
  if (process.platform === "darwin") {
    return "Open Docker Desktop, wait until it says it is running, then re-run setup.";
  }
  if (process.platform === "linux") {
    return "Start the Docker daemon (for example, sudo systemctl start docker), then re-run setup.";
  }
  return "Start Docker, then re-run setup.";
}

function dockerOptionalDetail(reason: string): string {
  return `${reason} OpenHands code execution is optional during setup, so ScienceSwarm will continue without it for now.`;
}

function dockerErrorDetail(error: string | undefined): string {
  if (!error) return "";
  const lower = error.toLowerCase();
  if (lower.includes("docker.sock") || lower.includes("daemon")) {
    return " Last Docker error: the daemon socket was not available.";
  }
  return ` Last Docker error: ${error.slice(0, 240)}`;
}

export const openhandsDockerTask: InstallTask = {
  id: "openhands-docker",
  async *run() {
    yield { status: "running", detail: "Checking for Docker…" };
    const dockerCli = await resolveDockerCli();
    if (!dockerCli) {
      yield {
        status: "skipped",
        detail: dockerOptionalDetail(
          process.platform === "linux"
            ? "Docker is not installed."
            : "Docker Desktop is not installed.",
        ),
      };
      return;
    }

    let ready = await dockerInfo(dockerCli);
    if (!ready.ok) {
      yield { status: "running", detail: startDockerDetail() };
      await startDocker();
      ready = yield* waitForDockerWithProgress(dockerCli);
    }

    if (!ready.ok) {
      yield {
        status: "skipped",
        detail: dockerOptionalDetail(
          `Docker is installed but the daemon is not ready yet. ${dockerRecoveryHint()}${dockerErrorDetail(ready.error)}`,
        ),
      };
      return;
    }

    yield {
      status: "succeeded",
      detail:
        "Docker is ready. ScienceSwarm will provision OpenHands code execution when you first use it.",
    };
  },
};
