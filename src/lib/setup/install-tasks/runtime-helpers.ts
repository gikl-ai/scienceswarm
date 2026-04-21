import { spawn } from "node:child_process";

export const BREW_CANDIDATES = [
  "/opt/homebrew/bin/brew",
  "/usr/local/bin/brew",
];

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface CommandOptions {
  maxOutputChars?: number;
}

function appendBounded(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export function cleanProcessOutput(value: string, limit = 500): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, limit);
}

export function runCommand(
  command: string,
  args: string[] = [],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const maxOutputChars = options.maxOutputChars ?? 20_000;
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, String(chunk), maxOutputChars);
    });
    proc.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, String(chunk), maxOutputChars);
    });
    proc.on("error", (err) =>
      resolve({ ok: false, stdout, stderr: String(err), code: null }),
    );
    proc.on("close", (code) =>
      resolve({ ok: code === 0, stdout, stderr, code }),
    );
  });
}

export async function which(name: string): Promise<string | null> {
  const command = process.platform === "win32" ? "where" : "which";
  const result = await runCommand(command, [name], { maxOutputChars: 4_000 });
  if (!result.ok) return null;
  return (
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

export async function executableWorks(
  command: string,
  args: string[] = ["--version"],
): Promise<boolean> {
  return (await runCommand(command, args, { maxOutputChars: 4_000 })).ok;
}

async function resolveExecutableCandidate(
  candidates: Array<string | null | undefined>,
): Promise<string | null> {
  const unique = Array.from(
    new Set(candidates.filter((candidate): candidate is string => Boolean(candidate))),
  );
  for (const candidate of unique) {
    if (await executableWorks(candidate)) return candidate;
  }
  return null;
}

export async function resolveExecutable(
  name: string,
  candidates: Array<string | null | undefined> = [],
): Promise<string | null> {
  const pathCandidate = await which(name);
  return resolveExecutableCandidate([pathCandidate, ...candidates]);
}

async function resolveDarwinHostArchitecture(): Promise<"arm64" | "x86_64" | "unknown"> {
  if (process.platform !== "darwin") return "unknown";
  const [hardwareArm64Support, processTranslated] = await Promise.all([
    runCommand("sysctl", ["-in", "hw.optional.arm64"], { maxOutputChars: 1_000 }),
    runCommand("sysctl", ["-in", "sysctl.proc_translated"], { maxOutputChars: 1_000 }),
  ]);
  if (
    hardwareArm64Support.stdout.trim() === "1"
    || processTranslated.stdout.trim() === "1"
  ) {
    return "arm64";
  }
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x86_64";
  return "unknown";
}

function isNativeBrewPath(path: string, architecture: "arm64" | "x86_64" | "unknown"): boolean {
  if (architecture === "arm64") return path.startsWith("/opt/homebrew/");
  if (architecture === "x86_64") return !path.startsWith("/opt/homebrew/");
  return true;
}

export async function resolveBrew(): Promise<string | null> {
  const pathCandidate = await which("brew");
  if (process.platform !== "darwin") {
    return resolveExecutableCandidate([pathCandidate, ...BREW_CANDIDATES]);
  }

  const architecture = await resolveDarwinHostArchitecture();
  const candidates = [pathCandidate, ...BREW_CANDIDATES].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && isNativeBrewPath(candidate, architecture),
  );
  return resolveExecutableCandidate(candidates);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}
