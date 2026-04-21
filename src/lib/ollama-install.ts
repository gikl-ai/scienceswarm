import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type OllamaPlatform = "darwin" | "linux" | "other";
export type OllamaArchitecture = "arm64" | "x86_64" | "universal" | "unknown";
export type OllamaInstaller = "homebrew" | "download" | "linux-script" | "manual";
export type OllamaServiceManager = "brew" | "systemctl" | "direct";
export type OllamaBinarySource = "app" | "homebrew" | "manual" | "unknown";

export interface OllamaInstallStatus {
  hostPlatform: OllamaPlatform;
  hostArchitecture: OllamaArchitecture;
  binaryInstalled: boolean;
  binaryPath: string | null;
  binaryVersion: string | null;
  binaryArchitecture: OllamaArchitecture | null;
  binaryCompatible: boolean;
  reinstallRecommended: boolean;
  preferredInstaller: OllamaInstaller;
  installCommand: string | null;
  installHint: string;
  installUrl: string;
  serviceManager: OllamaServiceManager;
  startCommand: string | null;
  stopCommand: string | null;
}

interface BinaryProbe {
  path: string;
  resolvedPath: string | null;
  architecture: OllamaArchitecture;
  version: string | null;
  source: OllamaBinarySource;
}

interface InstallPlan {
  preferredInstaller: OllamaInstaller;
  installCommand: string | null;
  installHint: string;
  installUrl: string;
}

interface ServicePlan {
  serviceManager: OllamaServiceManager;
  startCommand: string | null;
  stopCommand: string | null;
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function normalizeBinaryPath(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

export function normalizeArchitecture(value: string | null | undefined): OllamaArchitecture {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) return "unknown";
  if (normalized.includes("universal")) return "universal";
  if (normalized === "x64" || normalized.includes("x86_64") || normalized.includes("amd64")) {
    return "x86_64";
  }
  if (normalized.includes("arm64") || normalized.includes("aarch64")) {
    return "arm64";
  }
  return "unknown";
}

export function parseBinaryArchitecture(description: string | null | undefined): OllamaArchitecture {
  const normalized = description?.trim().toLowerCase() ?? "";
  if (!normalized) return "unknown";

  const hasArm = normalized.includes("arm64") || normalized.includes("aarch64");
  const hasX64 = normalized.includes("x86_64") || normalized.includes("amd64");
  if (normalized.includes("universal") || (hasArm && hasX64)) {
    return "universal";
  }
  if (hasArm) return "arm64";
  if (hasX64) return "x86_64";
  return "unknown";
}

export function inferDarwinHostArchitecture({
  processArchitecture,
  hardwareArm64Support,
  processTranslated,
}: {
  processArchitecture: OllamaArchitecture;
  hardwareArm64Support: string | null;
  processTranslated: string | null;
}): OllamaArchitecture {
  if (hardwareArm64Support?.trim() === "1" || processTranslated?.trim() === "1") {
    return "arm64";
  }

  return processArchitecture;
}

export function detectBinarySource(
  path: string,
  resolvedPath: string | null | undefined,
): OllamaBinarySource {
  const candidates = [path, resolvedPath]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => normalizeBinaryPath(candidate));

  if (candidates.some((candidate) => candidate.includes("/ollama.app/contents/resources/ollama"))) {
    return "app";
  }

  if (candidates.some((candidate) => candidate.includes("/cellar/ollama/"))) {
    return "homebrew";
  }

  if (candidates.length > 0) {
    return "manual";
  }

  return "unknown";
}

export function isArchitectureCompatible(
  hostArchitecture: OllamaArchitecture,
  binaryArchitecture: OllamaArchitecture | null,
): boolean {
  if (!binaryArchitecture || binaryArchitecture === "unknown" || binaryArchitecture === "universal") {
    return true;
  }
  if (hostArchitecture === "unknown") return true;
  return hostArchitecture === binaryArchitecture;
}

export function buildInstallPlan({
  hostPlatform,
  hostArchitecture,
  preferredBrewPath,
}: {
  hostPlatform: OllamaPlatform;
  hostArchitecture: OllamaArchitecture;
  preferredBrewPath: string | null;
}): InstallPlan {
  const installUrl = "https://ollama.com/download";

  if (hostPlatform === "darwin") {
    if (hostArchitecture === "arm64") {
      if (preferredBrewPath) {
        return {
          preferredInstaller: "homebrew",
          installCommand: `${quoteShell(preferredBrewPath)} install ollama`,
          installHint:
            "Apple Silicon detected. ScienceSwarm will install the native arm64 Ollama build instead of using Intel Homebrew under /usr/local.",
          installUrl,
        };
      }

      return {
        preferredInstaller: "download",
        installCommand: null,
        installHint:
          "Apple Silicon detected, but native Homebrew was not found at /opt/homebrew/bin/brew. Install the native Ollama app from https://ollama.com/download instead of using Intel Homebrew.",
        installUrl,
      };
    }

    if (preferredBrewPath) {
      return {
        preferredInstaller: "homebrew",
        installCommand: `${quoteShell(preferredBrewPath)} install ollama`,
        installHint: "Install Ollama with Homebrew on macOS.",
        installUrl,
      };
    }

    return {
      preferredInstaller: "download",
      installCommand: null,
      installHint: "Homebrew was not found. Install Ollama manually from https://ollama.com/download.",
      installUrl,
    };
  }

  if (hostPlatform === "linux") {
    return {
      preferredInstaller: "linux-script",
      installCommand: "curl -fsSL https://ollama.com/install.sh | sh",
      installHint: "Install Ollama with the official Linux installer script.",
      installUrl: "https://ollama.com/install.sh",
    };
  }

  return {
    preferredInstaller: "manual",
    installCommand: null,
    installHint: "Install Ollama manually from https://ollama.com/download.",
    installUrl,
  };
}

export function buildServicePlan({
  hostPlatform,
  preferredBrewPath,
  systemctlAvailable,
  binaryPath,
  binarySource,
}: {
  hostPlatform: OllamaPlatform;
  preferredBrewPath: string | null;
  systemctlAvailable: boolean;
  binaryPath: string | null;
  binarySource?: OllamaBinarySource | null;
}): ServicePlan {
  if (hostPlatform === "darwin" && preferredBrewPath && binarySource === "homebrew") {
    return {
      serviceManager: "brew",
      startCommand: `${quoteShell(preferredBrewPath)} services start ollama`,
      stopCommand: `${quoteShell(preferredBrewPath)} services stop ollama`,
    };
  }

  if (hostPlatform === "linux" && systemctlAvailable) {
    return {
      serviceManager: "systemctl",
      startCommand: "systemctl --user start ollama",
      stopCommand: "systemctl --user stop ollama",
    };
  }

  if (hostPlatform === "other") {
    return {
      serviceManager: "direct",
      startCommand: null,
      stopCommand: null,
    };
  }

  const directBinary = binaryPath || "ollama";
  return {
    serviceManager: "direct",
    startCommand: `nohup ${quoteShell(directBinary)} serve >/tmp/ollama-serve.log 2>&1 &`,
    stopCommand: "pkill -f 'ollama serve'",
  };
}

async function readCommandOutput(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args);
    return typeof stdout === "string" ? stdout.trim() : "";
  } catch {
    return null;
  }
}

async function commandPath(name: string): Promise<string | null> {
  const stdout = await readCommandOutput("which", [name]);
  if (stdout === null) return null;
  const firstLine = stdout.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine || name;
}

async function probeBinary(path: string): Promise<BinaryProbe | null> {
  // `file -Lb` prints "cannot open '<path>' (No such file or directory)"
  // to stdout and still exits 0 on macOS when the path is missing, so
  // a non-null `description` does NOT prove the binary exists. Gate
  // acceptance on two stronger signals:
  //   * `realpath(path)` succeeded (the file actually resolves on disk)
  //   OR
  //   * `--version` produced output (the binary is executable and ran)
  // Either is sufficient; together they cover a symlink into a missing
  // target and a binary that doesn't support `--version`.
  //
  // Fan the three I/O calls out in parallel — they're independent, and
  // `resolveOllamaBinary` / `resolvePreferredBrewPath` already iterate
  // up to four candidate paths concurrently, so halving per-path
  // latency meaningfully shortens cold-start setup probes.
  const [resolvedPath, description, versionOutput] = await Promise.all([
    realpath(path).catch(() => null),
    readCommandOutput("file", ["-Lb", path]),
    readCommandOutput(path, ["--version"]),
  ]);
  if (resolvedPath === null && versionOutput === null) {
    return null;
  }

  return {
    path,
    resolvedPath,
    architecture: parseBinaryArchitecture(description),
    version: versionOutput?.split("\n").map((line) => line.trim()).find(Boolean) ?? null,
    source: detectBinarySource(path, resolvedPath),
  };
}

async function resolveHostArchitecture(hostPlatform: OllamaPlatform): Promise<OllamaArchitecture> {
  const processArchitecture = normalizeArchitecture(process.arch);
  if (hostPlatform !== "darwin") {
    return processArchitecture;
  }

  const [hardwareArm64Support, processTranslated] = await Promise.all([
    readCommandOutput("sysctl", ["-in", "hw.optional.arm64"]),
    readCommandOutput("sysctl", ["-in", "sysctl.proc_translated"]),
  ]);

  return inferDarwinHostArchitecture({
    processArchitecture,
    hardwareArm64Support,
    processTranslated,
  });
}

async function resolvePreferredBrewPath(
  hostPlatform: OllamaPlatform,
  hostArchitecture: OllamaArchitecture,
): Promise<string | null> {
  if (hostPlatform !== "darwin") return null;

  const pathBrew = await commandPath("brew");
  const candidates = hostArchitecture === "arm64"
    ? ["/opt/homebrew/bin/brew", pathBrew, "/usr/local/bin/brew"]
    : [pathBrew, "/usr/local/bin/brew", "/opt/homebrew/bin/brew"];

  const unique = Array.from(new Set(candidates.filter((candidate): candidate is string => Boolean(candidate))));
  const probes = await Promise.all(unique.map(async (candidate) => probeBinary(candidate)));
  const available = probes.filter((probe): probe is BinaryProbe => probe !== null);
  if (available.length === 0) return null;

  const compatible = available.find((probe) => isArchitectureCompatible(hostArchitecture, probe.architecture));
  return compatible?.path ?? null;
}

async function resolveOllamaBinary(
  hostPlatform: OllamaPlatform,
  hostArchitecture: OllamaArchitecture,
): Promise<BinaryProbe | null> {
  const pathBinary = await commandPath("ollama");
  const candidates = (() => {
    if (hostPlatform === "darwin" && hostArchitecture === "arm64") {
      return [
        "/opt/homebrew/bin/ollama",
        pathBinary,
        "/Applications/Ollama.app/Contents/Resources/ollama",
        "/usr/local/bin/ollama",
      ];
    }

    if (hostPlatform === "darwin") {
      return [
        pathBinary,
        "/usr/local/bin/ollama",
        "/Applications/Ollama.app/Contents/Resources/ollama",
        "/opt/homebrew/bin/ollama",
      ];
    }

    if (hostPlatform === "linux") {
      return [pathBinary, "/usr/local/bin/ollama", "/usr/bin/ollama"];
    }

    return [pathBinary];
  })();

  const unique = Array.from(new Set(candidates.filter((candidate): candidate is string => Boolean(candidate))));
  const probes = await Promise.all(unique.map(async (candidate) => probeBinary(candidate)));
  const available = probes.filter((probe): probe is BinaryProbe => probe !== null);
  if (available.length === 0) return null;

  const compatible = available.find((probe) => isArchitectureCompatible(hostArchitecture, probe.architecture));
  return compatible ?? available[0] ?? null;
}

export async function getOllamaInstallStatus(): Promise<OllamaInstallStatus> {
  const hostPlatform: OllamaPlatform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : "other";
  const hostArchitecture = await resolveHostArchitecture(hostPlatform);
  const [binary, preferredBrewPath, systemctlPath] = await Promise.all([
    resolveOllamaBinary(hostPlatform, hostArchitecture),
    resolvePreferredBrewPath(hostPlatform, hostArchitecture),
    commandPath("systemctl"),
  ]);

  const binaryCompatible = isArchitectureCompatible(hostArchitecture, binary?.architecture ?? null);
  const reinstallRecommended = Boolean(
    binary
    && hostPlatform === "darwin"
    && hostArchitecture === "arm64"
    && !binaryCompatible,
  );

  const installPlan = buildInstallPlan({
    hostPlatform,
    hostArchitecture,
    preferredBrewPath,
  });
  const servicePlan = buildServicePlan({
    hostPlatform,
    preferredBrewPath,
    systemctlAvailable: Boolean(systemctlPath),
    binaryPath: binary?.path ?? null,
    binarySource: binary?.source ?? null,
  });

  return {
    hostPlatform,
    hostArchitecture,
    binaryInstalled: Boolean(binary),
    binaryPath: binary?.path ?? null,
    binaryVersion: binary?.version ?? null,
    binaryArchitecture: binary?.architecture ?? null,
    binaryCompatible,
    reinstallRecommended,
    preferredInstaller: installPlan.preferredInstaller,
    installCommand: installPlan.installCommand,
    installHint: installPlan.installHint,
    installUrl: installPlan.installUrl,
    serviceManager: servicePlan.serviceManager,
    startCommand: servicePlan.startCommand,
    stopCommand: servicePlan.stopCommand,
  };
}
