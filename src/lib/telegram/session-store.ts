/**
 * Telegram session storage. gramjs sessions serialize to a long
 * Base64-ish string; we persist them under `<SCIENCESWARM_DIR>/telegram/session`
 * with mode 600 (owner read/write only). Anyone who gets the file owns
 * the Telegram account, so restrictive permissions matter.
 *
 * The default directory honors `SCIENCESWARM_DIR` so a user who clones
 * the repo into a test checkout and sets `SCIENCESWARM_DIR=~/.scienceswarm-test`
 * gets a fully isolated session — no leakage between installs.
 *
 * Future: move to OS keychain via `@napi-rs/keyring`. Out of scope for
 * v1 — a mode-600 file on a single-user machine is equivalent in
 * practice.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { getScienceSwarmTelegramRoot } from "@/lib/scienceswarm-paths";

const SESSION_FILE = "session";

export interface SessionStoreOptions {
  dir?: string;
}

export class TelegramSessionStore {
  private readonly dir: string;

  constructor(options: SessionStoreOptions = {}) {
    // Resolve lazily at construction time so tests can override
    // via options.dir and production picks up `SCIENCESWARM_DIR`
    // from process.env at the moment the store is built.
    this.dir = options.dir ?? getScienceSwarmTelegramRoot();
  }

  async load(): Promise<string | null> {
    try {
      const contents = await fs.readFile(
        path.join(this.dir, SESSION_FILE),
        "utf8",
      );
      return contents.trim() || null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(session: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = path.join(this.dir, SESSION_FILE);
    await fs.writeFile(target, session, { encoding: "utf8", mode: 0o600 });
    // writeFile honors mode on creation but not on overwrite — chmod
    // explicitly so a second save doesn't silently widen permissions.
    await fs.chmod(target, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(path.join(this.dir, SESSION_FILE));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  path(): string {
    return path.join(this.dir, SESSION_FILE);
  }
}
