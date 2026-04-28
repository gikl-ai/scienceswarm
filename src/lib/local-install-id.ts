import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getScienceSwarmDataRoot } from "@/lib/scienceswarm-paths";

const LOCAL_INSTALL_ID_FILE = "install-id";
const LOCAL_INSTALL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,127}$/i;

export function getLocalInstallIdPath(): string {
  return join(getScienceSwarmDataRoot(), LOCAL_INSTALL_ID_FILE);
}

function normalizeLocalInstallId(value: string): string | null {
  const trimmed = value.trim();
  return LOCAL_INSTALL_ID_PATTERN.test(trimmed) ? trimmed : null;
}

async function readLocalInstallId(path: string): Promise<string | null> {
  try {
    return normalizeLocalInstallId(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

export async function getOrCreateLocalInstallId(): Promise<string> {
  const path = getLocalInstallIdPath();

  const existing = await readLocalInstallId(path);
  if (existing) {
    return existing;
  }

  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true });

  try {
    await writeFile(path, `${id}\n`, {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    return id;
  } catch (error) {
    if (isFileExistsError(error)) {
      const raced = await readLocalInstallId(path);
      if (raced) {
        return raced;
      }
    }
  }

  await writeFile(path, `${id}\n`, { encoding: "utf-8", mode: 0o600 });
  return id;
}
