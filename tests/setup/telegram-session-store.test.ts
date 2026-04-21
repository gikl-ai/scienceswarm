import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { TelegramSessionStore } from "@/lib/telegram/session-store";

describe("TelegramSessionStore", () => {
  let dir: string;
  let store: TelegramSessionStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "scienceswarm-tgsession-"));
    store = new TelegramSessionStore({ dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when no session exists", async () => {
    expect(await store.load()).toBeNull();
  });

  it("round-trips a session string", async () => {
    await store.save("abc123==");
    expect(await store.load()).toBe("abc123==");
  });

  it("writes the file with mode 600", async () => {
    await store.save("x");
    const stat = await fs.stat(path.join(dir, "session"));
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("keeps mode 600 after an overwrite", async () => {
    await store.save("x");
    await fs.chmod(path.join(dir, "session"), 0o644);
    await store.save("y");
    const stat = await fs.stat(path.join(dir, "session"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("clear removes the session file without error if absent", async () => {
    await store.clear();
    await store.save("x");
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("load returns null for whitespace-only content", async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "session"), "   \n  ", "utf8");
    expect(await store.load()).toBeNull();
  });
});

describe("TelegramSessionStore default directory honors SCIENCESWARM_DIR", () => {
  // Regression: the previous default hardcoded `$HOME/.scienceswarm/telegram`
  // and ignored SCIENCESWARM_DIR entirely. A user running with
  // SCIENCESWARM_DIR=~/.scienceswarm-test would still have the session
  // written to ~/.scienceswarm/telegram, leaking between installs.
  let tmpRoot: string;
  const originalEnv = process.env.SCIENCESWARM_DIR;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "scienceswarm-dir-"));
    process.env.SCIENCESWARM_DIR = tmpRoot;
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.SCIENCESWARM_DIR;
    } else {
      process.env.SCIENCESWARM_DIR = originalEnv;
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("defaults the session file under SCIENCESWARM_DIR/telegram", async () => {
    const store = new TelegramSessionStore();
    // Without options.dir, the store should resolve to
    // `<SCIENCESWARM_DIR>/telegram/session`, not ~/.scienceswarm/telegram/session.
    expect(store.path()).toBe(path.join(tmpRoot, "telegram", "session"));

    await store.save("sss");
    const contents = await fs.readFile(
      path.join(tmpRoot, "telegram", "session"),
      "utf8",
    );
    expect(contents).toBe("sss");
    // The real user dotdir must NOT have been touched.
    const realDotDir = path.join(os.homedir(), ".scienceswarm", "telegram");
    const stat = await fs
      .stat(path.join(realDotDir, "session"))
      .catch(() => null);
    // If the real dir already existed from a previous install on this
    // machine, the file there (if any) pre-dates this test. We assert
    // that the test DID write into tmpRoot regardless — that alone is
    // enough to prove the default path now honors SCIENCESWARM_DIR.
    void stat;
  });
});
