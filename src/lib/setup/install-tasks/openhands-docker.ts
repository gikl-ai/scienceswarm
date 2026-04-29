/**
 * OpenHands code-execution readiness task.
 *
 * First-run onboarding should produce a functional local service when
 * possible: Docker running, the pinned OpenHands image present, and the
 * ScienceSwarm-managed OpenHands container started in local Ollama mode.
 *
 * Docker Desktop itself is not bundled in the DMG. On macOS we can install it
 * through Homebrew when available; otherwise we surface an actionable skipped
 * state so the user can accept Docker's own installer/license outside our app.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  getFrontendPort,
  getOpenHandsPort,
  getOpenHandsUrl,
} from "@/lib/config/ports";
import { resolveOpenHandsLocalRuntimeConfig } from "@/lib/runtime/model-catalog";
import { getScienceSwarmDataRoot } from "@/lib/scienceswarm-paths";

import type { InstallTask, TaskYield } from "./types";
import {
  cleanProcessOutput,
  resolveBrew,
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
const OPENHANDS_HEALTH_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(
    process.env.OPENHANDS_HEALTH_TIMEOUT_MS ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 90_000;
})();
const OPENHANDS_HEALTH_POLL_INTERVAL_MS = 2_000;
const OPENHANDS_CONTAINER_NAME = "scienceswarm-agent";
const DEFAULT_OPENHANDS_IMAGE =
  "docker.openhands.dev/openhands/openhands@sha256:5c0dc26f467bf8e47a6e76308edb7a30af4084b17e23a3460b5467008b12111b";

const DOCKER_CLI_CANDIDATES = [
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/usr/bin/docker",
];

async function resolveDockerCli(): Promise<string | null> {
  return resolveExecutable("docker", DOCKER_CLI_CANDIDATES);
}

function truthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value ?? "");
}

function shouldSkipRuntimeDownloads(): boolean {
  return truthyEnv(process.env.SCIENCESWARM_SKIP_RUNTIME_DOWNLOADS);
}

function shouldSkipOpenHandsPull(): boolean {
  return (
    shouldSkipRuntimeDownloads()
    || truthyEnv(process.env.SCIENCESWARM_SKIP_OPENHANDS_PULL)
  );
}

function shouldSkipOpenHandsStart(): boolean {
  return (
    truthyEnv(process.env.SCIENCESWARM_SKIP_OPENHANDS_START)
    || shouldSkipRuntimeDownloads()
  );
}

function getOpenHandsImage(): string {
  return process.env.OPENHANDS_IMAGE?.trim() || DEFAULT_OPENHANDS_IMAGE;
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

async function installDockerDesktop(): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      error:
        process.platform === "linux"
          ? "Docker is not installed. Install Docker Engine from https://docs.docker.com/engine/install/, start the daemon, then re-run setup."
          : `Docker is not installed on unsupported platform ${process.platform}.`,
    };
  }

  const brew = await resolveBrew();
  if (!brew) {
    return {
      ok: false,
      error:
        "Docker Desktop is not installed and Homebrew was not found. Install Docker Desktop from https://docs.docker.com/desktop/setup/install/mac-install/, open it once, then re-run setup.",
    };
  }

  const result = await runCommand(brew, ["install", "--cask", "docker"], {
    maxOutputChars: 12_000,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: `brew install --cask docker failed: ${cleanProcessOutput(result.stderr || result.stdout)}`,
    };
  }
  return { ok: true };
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

function dockerUnavailableDetail(reason: string): string {
  return `${reason} OpenHands code execution needs Docker before ScienceSwarm can start the local OpenHands service.`;
}

function dockerErrorDetail(error: string | undefined): string {
  if (!error) return "";
  const lower = error.toLowerCase();
  if (lower.includes("docker.sock") || lower.includes("daemon")) {
    return " Last Docker error: the daemon socket was not available.";
  }
  return ` Last Docker error: ${error.slice(0, 240)}`;
}

async function dockerImagePresent(
  dockerCli: string,
  image: string,
): Promise<boolean> {
  return (await runCommand(dockerCli, ["image", "inspect", image], {
    maxOutputChars: 4_000,
  })).ok;
}

async function openHandsReachable(timeoutMs = OPENHANDS_HEALTH_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(getOpenHandsUrl(), {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return true;
    } catch {
      // Keep polling until the deadline.
    }
    await sleep(OPENHANDS_HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

async function startOpenHandsContainer(dockerCli: string, image: string): Promise<{
  ok: boolean;
  started: boolean;
  detail?: string;
  error?: string;
}> {
  if (await openHandsReachable(1)) {
    return {
      ok: true,
      started: false,
      detail: "OpenHands is already reachable.",
    };
  }

  const runtime = resolveOpenHandsLocalRuntimeConfig({
    ...process.env,
    LLM_PROVIDER: "local",
  });
  const openHandsDataRoot = join(getScienceSwarmDataRoot(), "openhands");
  await mkdir(openHandsDataRoot, { recursive: true });

  await runCommand(dockerCli, ["rm", "-f", OPENHANDS_CONTAINER_NAME], {
    maxOutputChars: 4_000,
  });

  const hostUrl =
    process.env.SCIENCESWARM_HOST_URL?.trim()
    || `http://host.docker.internal:${getFrontendPort()}`;
  const sandboxToken = process.env.SCIENCESWARM_SANDBOX_TOKEN?.trim() || "";
  const agentServerEnv = JSON.stringify({
    SCIENCESWARM_HOST_URL: hostUrl,
    SCIENCESWARM_SANDBOX_TOKEN: sandboxToken,
  });

  const args = [
    "run",
    "-d",
    "--rm",
    "-e",
    "LLM_PROVIDER=local",
    "-e",
    `LLM_MODEL=${runtime.model}`,
    "-e",
    `LLM_BASE_URL=${runtime.baseUrl}`,
    "-e",
    `LLM_API_KEY=${runtime.apiKey}`,
    "-e",
    `OLLAMA_CONTEXT_LENGTH=${runtime.contextLength}`,
    "-e",
    `AGENT_SERVER_IMAGE_REPOSITORY=${process.env.AGENT_SERVER_IMAGE_REPOSITORY ?? ""}`,
    "-e",
    `AGENT_SERVER_IMAGE_TAG=${process.env.AGENT_SERVER_IMAGE_TAG ?? ""}`,
    "-e",
    `OH_AGENT_SERVER_ENV=${agentServerEnv}`,
    "-e",
    "MAX_ITERATIONS=100",
    "-e",
    "LOG_ALL_EVENTS=true",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-v",
    `${openHandsDataRoot}:/.openhands`,
    "-p",
    `127.0.0.1:${getOpenHandsPort()}:3000`,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--name",
    OPENHANDS_CONTAINER_NAME,
    image,
  ];

  const result = await runCommand(dockerCli, args, { maxOutputChars: 12_000 });
  if (!result.ok) {
    return {
      ok: false,
      started: false,
      error: `docker run ${OPENHANDS_CONTAINER_NAME} failed: ${cleanProcessOutput(result.stderr || result.stdout)}`,
    };
  }

  return {
    ok: true,
    started: true,
    detail: `OpenHands container started with ${runtime.model}.`,
  };
}

export const openhandsDockerTask: InstallTask = {
  id: "openhands-docker",
  async *run() {
    yield { status: "running", detail: "Checking for Docker…" };
    let dockerCli = await resolveDockerCli();
    if (!dockerCli) {
      yield {
        status: "running",
        detail:
          process.platform === "darwin"
            ? "Installing Docker Desktop with Homebrew…"
            : "Docker is not installed.",
      };
      const installResult = await installDockerDesktop();
      if (installResult.ok) {
        dockerCli = await resolveDockerCli();
      }
      if (!dockerCli) {
        yield {
          status: "skipped",
          detail: dockerUnavailableDetail(
            installResult.error
            || (process.platform === "linux"
              ? "Docker is not installed."
              : "Docker Desktop is not installed."),
          ),
        };
        return;
      }
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
        detail: dockerUnavailableDetail(
          `Docker is installed but the daemon is not ready yet. ${dockerRecoveryHint()}${dockerErrorDetail(ready.error)}`,
        ),
      };
      return;
    }

    const image = getOpenHandsImage();
    if (shouldSkipOpenHandsPull()) {
      yield {
        status: "succeeded",
        detail:
          "Docker is ready. OpenHands image download was skipped by SCIENCESWARM_SKIP_RUNTIME_DOWNLOADS or SCIENCESWARM_SKIP_OPENHANDS_PULL.",
      };
      return;
    }

    if (!(await dockerImagePresent(dockerCli, image))) {
      yield {
        status: "running",
        detail: "Downloading the pinned OpenHands runtime image…",
      };
      const pull = await runCommand(dockerCli, ["pull", image], {
        maxOutputChars: 20_000,
      });
      if (!pull.ok) {
        yield {
          status: "failed",
          error: `docker pull ${image} failed: ${cleanProcessOutput(pull.stderr || pull.stdout)}`,
        };
        return;
      }
    }

    if (shouldSkipOpenHandsStart()) {
      yield {
        status: "succeeded",
        detail:
          "Docker is ready and the OpenHands image is available. OpenHands start was skipped by environment.",
      };
      return;
    }

    yield {
      status: "running",
      detail: "Starting the local OpenHands service…",
    };
    const startResult = await startOpenHandsContainer(dockerCli, image);
    if (!startResult.ok) {
      yield {
        status: "failed",
        error: startResult.error ?? "OpenHands failed to start.",
      };
      return;
    }

    if (startResult.started) {
      yield {
        status: "running",
        detail: "Waiting for OpenHands to become reachable…",
      };
      if (!(await openHandsReachable())) {
        yield {
          status: "skipped",
          detail:
            "The OpenHands container started but did not become reachable before the setup timeout. It may still be warming up; Settings can retry.",
        };
        return;
      }
    }

    yield {
      status: "succeeded",
      detail: startResult.detail || "OpenHands local service is reachable.",
    };
  },
};
