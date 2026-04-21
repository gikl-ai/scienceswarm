/**
 * ollama + gemma4 task. Installs Ollama via brew on macOS or via the
 * upstream install script on Linux, starts the daemon when needed, then
 * `ollama pull gemma4:latest`. If Ollama is already installed, skips
 * install and verifies/pulls the model.
 */

import type { InstallTask } from "./types";
import {
  cleanProcessOutput,
  resolveBrew,
  resolveExecutable,
  runCommand,
  sleep,
  startDetached,
} from "./runtime-helpers";

// Always pull the newest Gemma 4 family model. `gemma4:latest`
// follows whatever Ollama blesses as the current default tag for
// Gemma 4 — typically the mid-size variant sitting around 9 GB.
// Do NOT downgrade to `gemma3:4b` or an older family: Gemma 3 has
// weaker tool-calling and the whole point of local-first ScienceSwarm
// is running the newest open model we can fit.
const MODEL = "gemma4:latest";
const OLLAMA_START_TIMEOUT_MS = 90_000;
const OLLAMA_POLL_INTERVAL_MS = 1_500;

const OLLAMA_CLI_CANDIDATES = [
  "/opt/homebrew/bin/ollama",
  "/usr/local/bin/ollama",
  "/Applications/Ollama.app/Contents/Resources/ollama",
  "/usr/bin/ollama",
];

async function resolveOllamaCli(): Promise<string | null> {
  return resolveExecutable("ollama", OLLAMA_CLI_CANDIDATES);
}

async function installOllama(): Promise<{ ok: boolean; error?: string }> {
  if (process.platform === "darwin") {
    const brew = await resolveBrew();
    if (!brew) {
      return {
        ok: false,
        error:
          "Ollama is not installed and Homebrew was not found. Install Homebrew or Ollama from https://ollama.com/download, then re-run setup.",
      };
    }
    const { ok, stderr, stdout } = await runCommand(brew, ["install", "ollama"], {
      maxOutputChars: 12_000,
    });
    if (!ok)
      return {
        ok: false,
        error: `brew install ollama failed: ${cleanProcessOutput(stderr || stdout)}`,
      };
    return { ok: true };
  }
  if (process.platform === "linux") {
    // Greptile P2 acknowledgement: `curl | sh` is the upstream-recommended
    // Linux install path for Ollama (https://ollama.com/download/linux).
    // Users on a compromised DNS/CDN path would be vulnerable, but we
    // accept the same risk Homebrew does on macOS. Replacing with a
    // digest-verified download is worth it once we bundle a pinned
    // release — tracked separately.
    const { ok, stderr, stdout } = await runCommand(
      "sh",
      ["-c", "curl -fsSL https://ollama.com/install.sh | sh"],
      { maxOutputChars: 12_000 },
    );
    if (!ok)
      return {
        ok: false,
        error: `Ollama install script failed: ${cleanProcessOutput(stderr || stdout)}`,
      };
    return { ok: true };
  }
  return { ok: false, error: `Unsupported platform: ${process.platform}` };
}

async function listModels(
  ollamaCli: string,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const result = await runCommand(ollamaCli, ["list"], {
    maxOutputChars: 12_000,
  });
  if (!result.ok) {
    return {
      ok: false,
      models: [],
      error: cleanProcessOutput(result.stderr || result.stdout),
    };
  }
  const models = result.stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
  return { ok: true, models };
}

function modelMatches(installed: string, target: string): boolean {
  return installed === target || installed.startsWith(`${target}:`);
}

async function waitForOllama(
  ollamaCli: string,
  timeoutMs = OLLAMA_START_TIMEOUT_MS,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = await listModels(ollamaCli);
  while (!last.ok && Date.now() <= deadline) {
    await sleep(OLLAMA_POLL_INTERVAL_MS);
    last = await listModels(ollamaCli);
  }
  return last;
}

async function startOllama(ollamaCli: string): Promise<void> {
  if (process.platform === "darwin") {
    const openResult = await runCommand("open", ["-ga", "Ollama"], {
      maxOutputChars: 4_000,
    });
    if (openResult.ok) return;

    const brew = await resolveBrew();
    if (brew) {
      const result = await runCommand(brew, ["services", "start", "ollama"], {
        maxOutputChars: 4_000,
      });
      if (result.ok) return;
    }
  }

  if (process.platform === "linux") {
    const systemctl = await resolveExecutable("systemctl");
    if (systemctl) {
      const result = await runCommand(systemctl, ["--user", "start", "ollama"], {
        maxOutputChars: 4_000,
      });
      if (result.ok) return;
    }
  }

  await startDetached(ollamaCli, ["serve"]);
}

export const ollamaGemmaTask: InstallTask = {
  id: "ollama-gemma",
  async *run() {
    yield { status: "running", detail: "Checking for Ollama…" };
    let cli = await resolveOllamaCli();
    if (!cli) {
      yield { status: "running", detail: "Installing Ollama…" };
      const result = await installOllama();
      if (!result.ok) {
        yield {
          status: "failed",
          error: result.error ?? "Ollama install failed",
        };
        return;
      }
      cli = await resolveOllamaCli();
      if (!cli) {
        yield {
          status: "failed",
          error: "ollama not on PATH after install",
        };
        return;
      }
    }

    let local = await listModels(cli);
    if (!local.ok) {
      yield { status: "running", detail: "Starting Ollama…" };
      await startOllama(cli);
      local = await waitForOllama(cli);
      if (!local.ok) {
        yield {
          status: "failed",
          error:
            `Ollama is installed but the daemon is not ready. Start Ollama, then re-run setup.${local.error ? ` Last error: ${local.error}` : ""}`,
        };
        return;
      }
    }

    if (local.models.some((name) => modelMatches(name, MODEL))) {
      yield { status: "succeeded", detail: `${MODEL} ready.` };
      return;
    }

    yield {
      status: "running",
      detail: `Pulling ${MODEL} (~9GB)…`,
    };
    const { ok, stderr, stdout } = await runCommand(cli, ["pull", MODEL], {
      maxOutputChars: 20_000,
    });
    if (!ok) {
      yield {
        status: "failed",
        error: `ollama pull ${MODEL} failed: ${cleanProcessOutput(stderr || stdout)}`,
      };
      return;
    }
    yield { status: "succeeded", detail: `${MODEL} ready.` };
  },
};
