import { execFile } from "node:child_process";
import { isLocalRequest } from "@/lib/local-guard";

function execFileText(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        const enrichedError = error as Error & { stdout?: string; stderr?: string };
        enrichedError.stdout = typeof stdout === "string" ? stdout : "";
        enrichedError.stderr = typeof stderr === "string" ? stderr : "";
        reject(enrichedError);
        return;
      }

      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
      });
    });
  });
}

function normalizeSelectedPath(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  if (/^[\\/]+$/.test(trimmed)) {
    return process.platform === "win32" ? "\\" : "/";
  }
  if (/^[A-Za-z]:[\\/]*$/.test(trimmed)) {
    return `${trimmed[0]}:\\`;
  }
  const normalized = trimmed.replace(/[\\\/]+$/, "");
  return normalized.length > 0 ? normalized : null;
}

function isPickerCancellation(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === 1) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  const details = [
    error.message,
    "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
  ]
    .filter(Boolean)
    .join("\n");
  return /cancelled|canceled|user canceled|user cancelled/i.test(details);
}

function hasCommand(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [name], (error) => resolve(!error));
  });
}

async function pickFolderOnMac(): Promise<string | null> {
  const { stdout } = await execFileText("osascript", [
    "-e",
    'tell application "System Events" to activate',
    "-e",
    'POSIX path of (choose folder with prompt "Choose a folder to import into ScienceSwarm")',
  ]);
  return normalizeSelectedPath(stdout);
}

async function pickFolderOnLinux(): Promise<string | null> {
  if (await hasCommand("zenity")) {
    const { stdout } = await execFileText("zenity", [
      "--file-selection",
      "--directory",
      "--title=Choose a folder to import into ScienceSwarm",
    ]);
    return normalizeSelectedPath(stdout);
  }

  if (await hasCommand("kdialog")) {
    const { stdout } = await execFileText("kdialog", [
      "--getexistingdirectory",
      process.env.HOME || ".",
      "--title",
      "Choose a folder to import into ScienceSwarm",
    ]);
    return normalizeSelectedPath(stdout);
  }

  throw new Error("No supported local folder picker found. Install zenity or kdialog, or paste a path manually.");
}

async function pickFolderOnWindows(): Promise<string | null> {
  const command = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    '$dialog.Description = "Choose a folder to import into ScienceSwarm"',
    "$dialog.ShowNewFolderButton = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
  ].join("; ");

  const { stdout } = await execFileText("powershell", [
    "-NoProfile",
    "-STA",
    "-Command",
    command,
  ]);
  return normalizeSelectedPath(stdout);
}

async function pickLocalFolder(): Promise<string | null> {
  if (process.platform === "darwin") {
    return pickFolderOnMac();
  }

  if (process.platform === "linux") {
    return pickFolderOnLinux();
  }

  if (process.platform === "win32") {
    return pickFolderOnWindows();
  }

  throw new Error("Local folder picker is not supported on this platform. Paste a path manually instead.");
}

export async function POST() {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const path = await pickLocalFolder();
    if (!path) {
      return Response.json({ cancelled: true });
    }
    return Response.json({ path });
  } catch (error) {
    if (isPickerCancellation(error)) {
      return Response.json({ cancelled: true });
    }

    return Response.json(
      {
        error: "Local folder picker failed. Paste a path manually or try again.",
      },
      { status: 500 },
    );
  }
}
