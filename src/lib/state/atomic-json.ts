import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export const atomicJsonFs = {
  readFile: fs.readFile,
  writeFile: fs.writeFile,
  rename: fs.rename,
  mkdir: fs.mkdir,
  rm: fs.rm,
};

const updateQueues = new Map<string, Promise<void>>();

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await atomicJsonFs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await atomicJsonFs.mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );

  const payload = `${JSON.stringify(value, null, 2)}\n`;

  await atomicJsonFs.writeFile(tempPath, payload, "utf-8");

  try {
    await atomicJsonFs.rename(tempPath, filePath);
  } catch (error) {
    await atomicJsonFs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function updateJsonFile<T>(
  filePath: string,
  updater: (current: T | null) => T,
): Promise<T> {
  const queueKey = path.resolve(filePath);
  const previous = updateQueues.get(queueKey) ?? Promise.resolve();
  const settledPrevious = previous.catch(() => undefined);

  let releaseQueue!: () => void;
  const queueTail = settledPrevious.then(
    () =>
      new Promise<void>((resolve) => {
        releaseQueue = resolve;
      }),
  );

  updateQueues.set(queueKey, queueTail);

  await settledPrevious;

  try {
    const current = await readJsonFile<T>(filePath);
    const next = updater(current);
    await writeJsonFile(filePath, next);
    return next;
  } finally {
    releaseQueue();
    if (updateQueues.get(queueKey) === queueTail) {
      updateQueues.delete(queueKey);
    }
  }
}
