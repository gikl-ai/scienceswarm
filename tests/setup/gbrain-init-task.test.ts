import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  InstallError,
  InstallerEvent,
} from "@/lib/setup/gbrain-installer";
import type { TaskYield } from "@/lib/setup/install-tasks/types";

const mockRunInstaller = vi.fn();
const mockDefaultInstallerEnvironment = vi.fn();
const mockGetScienceSwarmBrainRoot = vi.fn();
const mockInitBrain = vi.fn();

vi.mock("@/lib/setup/gbrain-installer", async () => {
  const actual = await vi.importActual<typeof import("@/lib/setup/gbrain-installer")>(
    "@/lib/setup/gbrain-installer",
  );
  return {
    ...actual,
    defaultInstallerEnvironment: () => mockDefaultInstallerEnvironment(),
    runInstaller: (...args: unknown[]) => mockRunInstaller(...args),
  };
});

vi.mock("@/lib/scienceswarm-paths", () => ({
  getScienceSwarmBrainRoot: () => mockGetScienceSwarmBrainRoot(),
}));

vi.mock("@/brain/init", () => ({
  initBrain: (...args: unknown[]) => mockInitBrain(...args),
}));

async function* events(items: InstallerEvent[]): AsyncGenerator<InstallerEvent> {
  for (const item of items) yield item;
}

async function runTask(): Promise<TaskYield[]> {
  const { gbrainInitTask } = await import(
    "@/lib/setup/install-tasks/gbrain-init"
  );
  const out: TaskYield[] = [];
  for await (const event of gbrainInitTask.run({
    handle: "test-user",
    repoRoot: "/tmp/fake-repo",
  })) {
    out.push(event);
  }
  return out;
}

describe("gbrain-init install task", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRunInstaller.mockReset();
    mockDefaultInstallerEnvironment.mockReset();
    mockGetScienceSwarmBrainRoot.mockReset();
    mockInitBrain.mockReset();
    mockDefaultInstallerEnvironment.mockResolvedValue({ fake: "env" });
    mockGetScienceSwarmBrainRoot.mockReturnValue("/tmp/fake-brain");
    mockInitBrain.mockReturnValue({
      root: "/tmp/fake-brain",
      created: true,
      message: "Brain initialized",
    });
  });

  it("surfaces the installer cause and recovery in bootstrap failures", async () => {
    const installError: InstallError = {
      code: "gbrain-init-failed",
      message: "gbrain failed to initialize the local PGLite database.",
      recovery: "Restart setup after fixing the PGLite extension path.",
      cause: "Extension bundle not found: /_next/static/media/vector.tar.gz",
    };
    mockRunInstaller.mockReturnValue(
      events([
        {
          type: "step",
          step: "gbrain-init",
          status: "failed",
          error: installError,
        },
        { type: "summary", status: "failed", error: installError },
      ]),
    );

    const result = await runTask();

    expect(result.at(-1)).toEqual({
      status: "failed",
      error:
        "gbrain failed to initialize the local PGLite database. Cause: Extension bundle not found: /_next/static/media/vector.tar.gz Recovery: Restart setup after fixing the PGLite extension path.",
    });
  });

  it("materializes BRAIN.md scaffolding after the installer succeeds", async () => {
    mockRunInstaller.mockReturnValue(
      events([{ type: "summary", status: "ok" }]),
    );

    const result = await runTask();

    expect(mockInitBrain).toHaveBeenCalledWith({
      root: "/tmp/fake-brain",
      name: "test-user",
    });
    expect(result.at(-1)).toEqual({
      status: "succeeded",
      detail: "Local research store initialized. Import data next to build your brain.",
    });
  });
});
