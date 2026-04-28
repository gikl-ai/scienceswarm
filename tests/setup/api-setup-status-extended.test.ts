/**
 * Extended GET /api/setup/status coverage for the PR B stage B1
 * additions: brainProfile / openclawStatus / ollamaStatus summaries.
 *
 * The upstream probes (OpenClaw CLI + Ollama install status) are
 * mocked via `vi.mock` so these tests run deterministically on CI
 * boxes that may or may not have either tool installed. Real probes
 * are covered in their own integration tests.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENV_FILE_NAME } from "../helpers/env-file";

// Hoisted mock controls — vi.mock factories run before top-level
// imports, so the per-test mutation API has to live on a
// vi.hoisted() object. This is the idiomatic way to feed different
// values into mocked modules across tests in Vitest.
const mocks = vi.hoisted(() => ({
  openclawImpl: undefined as
    | (() => Promise<
        { installed: boolean; configured: boolean; running: boolean }
      >)
    | undefined,
  ollamaImpl: undefined as (() => Promise<unknown>) | undefined,
  execFileImpl: undefined as
    | ((
        cmd: string,
        args: readonly string[],
      ) => { stdout: string; stderr: string } | Error)
    | undefined,
}));

vi.mock("@/lib/openclaw-status", () => ({
  getOpenClawSetupSummary: () => {
    if (!mocks.openclawImpl) {
      throw new Error("openclaw mock not configured for this test");
    }
    return mocks.openclawImpl();
  },
}));

vi.mock("@/lib/ollama-install", () => ({
  getOllamaInstallStatus: () => {
    if (!mocks.ollamaImpl) {
      throw new Error("ollama mock not configured for this test");
    }
    return mocks.ollamaImpl();
  },
}));

// Mock child_process so `probeOllamaRuntime` (which shells out to
// `ollama list`) doesn't actually exec against the developer or CI
// machine. The route promisifies execFile via `util.promisify`,
// which honors a `[util.promisify.custom]` symbol on the function
// to return the expected `{stdout, stderr}` shape; without that
// symbol the default resolver returns just the first non-err arg
// (the stdout string) and the destructure in the route explodes.
vi.mock("node:child_process", async () => {
  const util = await import("node:util");
  const execFile = (...args: unknown[]) => {
    const cb = args[args.length - 1] as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    const cmd = args[0] as string;
    const callArgs = (Array.isArray(args[1]) ? args[1] : []) as readonly string[];
    const impl = mocks.execFileImpl;
    if (!impl) {
      cb(null, "", "");
      return;
    }
    const result = impl(cmd, callArgs);
    if (result instanceof Error) {
      cb(result, "", "");
      return;
    }
    cb(null, result.stdout, result.stderr);
  };
  // Custom promisify shape so `await exec(...)` in the route
  // resolves to `{stdout, stderr}` instead of a bare string.
  (execFile as unknown as Record<symbol, unknown>)[util.promisify.custom] = (
    cmd: string,
    callArgs: readonly string[],
  ) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const impl = mocks.execFileImpl;
      if (!impl) {
        resolve({ stdout: "", stderr: "" });
        return;
      }
      const result = impl(cmd, callArgs);
      if (result instanceof Error) {
        reject(result);
        return;
      }
      resolve(result);
    });
  return { execFile };
});

describe("GET /api/setup/status — extended fields (PR B stage B1)", () => {
  let repoRoot: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "api-setup-status-ext-"),
    );
    tmpHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "api-setup-status-ext-home-"),
    );
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoRoot);

    // Default mocks for every test — individual tests can override
    // these before calling GET.
    mocks.openclawImpl = async () => ({
      installed: true,
      configured: true,
      running: false,
    });
    mocks.ollamaImpl = async () => ({
      hostPlatform: "darwin",
      hostArchitecture: "arm64",
      binaryInstalled: true,
      binaryPath: "/opt/homebrew/bin/ollama",
      binaryVersion: "ollama version 0.1.0",
      binaryArchitecture: "arm64",
      binaryCompatible: true,
      reinstallRecommended: false,
      preferredInstaller: "homebrew",
      installCommand: "'/opt/homebrew/bin/brew' install ollama",
      installHint: "Install Ollama with Homebrew on macOS.",
      installUrl: "https://ollama.com/download",
      serviceManager: "brew",
      startCommand: "'/opt/homebrew/bin/brew' services start ollama",
      stopCommand: "'/opt/homebrew/bin/brew' services stop ollama",
    });
    // Default exec: daemon running, no models listed. Individual
    // tests override to feed specific `ollama list` output or
    // simulate a non-running daemon.
    mocks.execFileImpl = () => ({ stdout: "", stderr: "" });
  });

  afterEach(async () => {
    cwdSpy?.mockRestore();
    cwdSpy = null;
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.rm(repoRoot, { recursive: true, force: true });
    await fs.rm(tmpHome, { recursive: true, force: true });
    mocks.openclawImpl = undefined;
    mocks.ollamaImpl = undefined;
    mocks.execFileImpl = undefined;
  });

  it("returns brainProfile fields read from .env", async () => {
    await fs.writeFile(
      path.join(repoRoot, ENV_FILE_NAME),
      [
        "BRAIN_PROFILE_NAME=Dr. Ada Lovelace",
        "BRAIN_PROFILE_FIELD=Analytical Engines",
        "BRAIN_PROFILE_INSTITUTION=London Mathematical Society",
      ].join("\n"),
      "utf8",
    );

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      brainProfile: { name: string; field: string; institution: string };
    };
    expect(body.brainProfile.name).toBe("Dr. Ada Lovelace");
    expect(body.brainProfile.field).toBe("Analytical Engines");
    expect(body.brainProfile.institution).toBe(
      "London Mathematical Society",
    );
  });

  it("returns empty brainProfile fields when keys are missing from .env", async () => {
    // An absent .env is a valid state the UI handles; the brain
    // profile block should surface as empty strings rather than
    // undefined so the form can render without null-guards.
    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      brainProfile: { name: string; field: string; institution: string };
    };
    expect(body.brainProfile).toEqual({
      name: "",
      field: "",
      institution: "",
    });
  });

  it("includes openclawStatus with installed/configured/running from the mocked probe", async () => {
    mocks.openclawImpl = async () => ({
      installed: true,
      configured: false,
      running: true,
    });

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openclawStatus: {
        installed: boolean;
        configured: boolean;
        running: boolean;
      };
    };
    expect(body.openclawStatus).toEqual({
      installed: true,
      configured: false,
      running: true,
    });
  });

  it("includes ollamaStatus projected from the mocked install probe", async () => {
    // Default exec mock returns empty stdout → daemon is reachable
    // (exit 0) but has no models pulled yet.
    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ollamaStatus: {
        installed: boolean;
        running: boolean;
        hasRecommendedModel: boolean;
        installCommand?: string;
        startCommand?: string;
      };
    };
    expect(body.ollamaStatus.installed).toBe(true);
    // Empty `ollama list` stdout still means the daemon ran the
    // command successfully, so running must be true.
    expect(body.ollamaStatus.running).toBe(true);
    expect(body.ollamaStatus.hasRecommendedModel).toBe(false);
    expect(body.ollamaStatus.installCommand).toContain("ollama");
    expect(body.ollamaStatus.startCommand).toContain("ollama");
  });

  it("includes installed Ollama model names in the initial status payload", async () => {
    mocks.execFileImpl = () => ({
      stdout: [
        "NAME              ID      SIZE   MODIFIED",
        "gemma4:latest     abc123   4GB    10 minutes ago",
        "qwen3:4b          def456   3GB    2 hours ago",
      ].join("\n"),
      stderr: "",
    });

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ollamaStatus: { models?: string[]; hasRecommendedModel: boolean };
    };
    expect(body.ollamaStatus.models).toEqual([
      "gemma4:latest",
      "qwen3:4b",
    ]);
    expect(body.ollamaStatus.hasRecommendedModel).toBe(true);
  });

  it("reports running=true, hasRecommendedModel=false when daemon is up but model is missing", async () => {
    // Simulate a running daemon with other models pulled but not the
    // recommended one. Regression: previously `running` was only
    // set when `hasModel` was also true, so this shape was reported
    // as `running: false` and pushed users back to the start command.
    mocks.execFileImpl = () => ({
      stdout:
        "NAME              ID      SIZE   MODIFIED\nmistral:latest   abc123   4GB    10 minutes ago\n",
      stderr: "",
    });

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ollamaStatus: { running: boolean; hasRecommendedModel: boolean };
    };
    expect(body.ollamaStatus.running).toBe(true);
    expect(body.ollamaStatus.hasRecommendedModel).toBe(false);
  });

  it("reports running=false when the daemon is offline (exec fails)", async () => {
    // Binary is installed but `ollama list` exits non-zero → daemon
    // is not running. Model presence should fall back to false
    // without making any further claims.
    mocks.execFileImpl = () =>
      new Error("connect ECONNREFUSED 127.0.0.1:11434");

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ollamaStatus: {
        installed: boolean;
        running: boolean;
        hasRecommendedModel: boolean;
      };
    };
    expect(body.ollamaStatus.installed).toBe(true);
    expect(body.ollamaStatus.running).toBe(false);
    expect(body.ollamaStatus.hasRecommendedModel).toBe(false);
  });

  it("matches the recommended model tag-aware: gemma4:latest is a hit, gemma4o-distilled is not", async () => {
    // Regression for the substring-match bug: `"line.includes(MODEL)"`
    // treated `gemma4o-distilled` as a match for `gemma4`. The new
    // matcher requires exact name equality or a `${MODEL}:` prefix,
    // so only the first line below should register as the recommended
    // model.
    mocks.execFileImpl = () => ({
      stdout: [
        "NAME                  ID      SIZE   MODIFIED",
        "gemma4:latest         abc123   4GB    2 hours ago",
        "gemma4o-distilled     def456   2GB    a day ago",
      ].join("\n"),
      stderr: "",
    });

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ollamaStatus: { running: boolean; hasRecommendedModel: boolean };
    };
    expect(body.ollamaStatus.running).toBe(true);
    expect(body.ollamaStatus.hasRecommendedModel).toBe(true);
  });

  it("does NOT match similarly-named models when the recommended model is absent", async () => {
    // Only `gemma4o-distilled` is installed — no exact `gemma4` or
    // `gemma4:*` tag. The probe must report the recommended model
    // missing so the pull button still surfaces.
    mocks.execFileImpl = () => ({
      stdout: [
        "NAME                  ID      SIZE   MODIFIED",
        "gemma4o-distilled     def456   2GB    a day ago",
      ].join("\n"),
      stderr: "",
    });

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ollamaStatus: { hasRecommendedModel: boolean };
    };
    expect(body.ollamaStatus.hasRecommendedModel).toBe(false);
  });

  it("does NOT treat gemma4:26b as the default recommended model", async () => {
    mocks.execFileImpl = () => ({
      stdout: [
        "NAME                  ID      SIZE   MODIFIED",
        "gemma4:26b            def456   18GB   a day ago",
      ].join("\n"),
      stderr: "",
    });

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ollamaStatus: { running: boolean; hasRecommendedModel: boolean; models?: string[] };
    };
    expect(body.ollamaStatus.running).toBe(true);
    expect(body.ollamaStatus.models).toEqual(["gemma4:26b"]);
    expect(body.ollamaStatus.hasRecommendedModel).toBe(false);
  });

  it("treats the low-memory Gemma 4 model as setup-ready", async () => {
    mocks.execFileImpl = () => ({
      stdout: [
        "NAME                  ID      SIZE   MODIFIED",
        "gemma4:e2b            abc123   7.2GB  10 minutes ago",
      ].join("\n"),
      stderr: "",
    });

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ollamaStatus: { running: boolean; hasRecommendedModel: boolean; models?: string[] };
    };
    expect(body.ollamaStatus.running).toBe(true);
    expect(body.ollamaStatus.models).toEqual(["gemma4:e2b"]);
    expect(body.ollamaStatus.hasRecommendedModel).toBe(true);
  });

  it("returns openclawStatus=undefined when the probe throws", async () => {
    mocks.openclawImpl = async () => {
      throw new Error("openclaw probe crashed");
    };
    // Silence the non-blocking probe-failure warning the route logs.
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openclawStatus?: unknown;
      ready: boolean;
    };
    expect(body.openclawStatus).toBeUndefined();
    // Primary readiness probe must still function — a failed
    // diagnostic cannot gate the whole status endpoint.
    expect(typeof body.ready).toBe("boolean");

    warnSpy.mockRestore();
  });

  it("returns ollamaStatus=undefined when the probe throws", async () => {
    mocks.ollamaImpl = async () => {
      throw new Error("ollama probe crashed");
    };
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ollamaStatus?: unknown };
    expect(body.ollamaStatus).toBeUndefined();

    warnSpy.mockRestore();
  });

  it("still reports ready=true when openclaw and ollama probes both fail", async () => {
    // Regression guard: the /setup readiness gate is backend +
    // provider config + data dir, nothing else. A crashed
    // diagnostic must not flip `ready` from true to false.
    const dir = path.join(tmpHome, "data");
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(repoRoot, ENV_FILE_NAME),
      [
        "AGENT_BACKEND=openclaw",
        "OPENAI_API_KEY=sk-real-key",
        `SCIENCESWARM_DIR=${dir}`,
        "",
      ].join("\n"),
      "utf8",
    );

    mocks.openclawImpl = async () => {
      throw new Error("openclaw exploded");
    };
    mocks.ollamaImpl = async () => {
      throw new Error("ollama exploded");
    };
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    const { GET } = await import("@/app/api/setup/status/route");
    const res = await GET(new Request("http://localhost/api/setup/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ready: boolean;
      openclawStatus?: unknown;
      ollamaStatus?: unknown;
    };
    expect(body.ready).toBe(true);
    expect(body.openclawStatus).toBeUndefined();
    expect(body.ollamaStatus).toBeUndefined();

    warnSpy.mockRestore();
  });
});
