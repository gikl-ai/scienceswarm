import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildScienceSwarmGbrainEnv,
  readScienceSwarmGbrainPackageState,
  scienceSwarmGbrainBin,
  scienceSwarmNodeBinDir,
} from "@/lib/gbrain/source-of-truth";

let tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
  tempRoots = [];
});

async function makeRepo(input: {
  expectedVersion: string;
  installedVersion?: string;
  writeBin?: boolean;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "scienceswarm-gbrain-source-"));
  tempRoots.push(root);
  await mkdir(path.join(root, "node_modules", "gbrain"), { recursive: true });
  await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/gbrain": {
          version: input.expectedVersion,
          resolved: "git+ssh://git@github.com/garrytan/gbrain.git#abc123",
        },
      },
    }),
    "utf8",
  );
  if (input.installedVersion) {
    await writeFile(
      path.join(root, "node_modules", "gbrain", "package.json"),
      JSON.stringify({
        name: "gbrain",
        version: input.installedVersion,
      }),
      "utf8",
    );
  }
  if (input.writeBin) {
    await writeFile(scienceSwarmGbrainBin(root), "#!/usr/bin/env node\n", "utf8");
  }
  return root;
}

describe("ScienceSwarm gbrain source of truth", () => {
  it("pins runtime env to the repo-local gbrain binary before global PATH entries", () => {
    const repoRoot = "/tmp/scienceswarm";
    const env = buildScienceSwarmGbrainEnv({
      NODE_ENV: "test",
      PATH: "/Users/alice/.bun/bin:/usr/bin",
      GBRAIN_BIN: "/Users/alice/.bun/bin/gbrain",
    }, repoRoot);

    expect(env.SCIENCESWARM_REPO_ROOT).toBe(repoRoot);
    expect(env.SCIENCESWARM_GBRAIN_BIN).toBe(scienceSwarmGbrainBin(repoRoot));
    expect(env.GBRAIN_BIN).toBe(scienceSwarmGbrainBin(repoRoot));
    expect(env.PATH?.split(path.delimiter)[0]).toBe(scienceSwarmNodeBinDir(repoRoot));
  });

  it("reports stale node_modules when installed gbrain differs from package-lock", async () => {
    const repoRoot = await makeRepo({
      expectedVersion: "0.20.4",
      installedVersion: "0.16.4",
      writeBin: true,
    });

    const state = readScienceSwarmGbrainPackageState(repoRoot);

    expect(state).toMatchObject({
      expectedVersion: "0.20.4",
      installedVersion: "0.16.4",
      inSync: false,
      binExists: true,
    });
  });

  it("accepts the installed gbrain package only when it matches the lockfile", async () => {
    const repoRoot = await makeRepo({
      expectedVersion: "0.20.4",
      installedVersion: "0.20.4",
      writeBin: true,
    });

    const state = readScienceSwarmGbrainPackageState(repoRoot);

    expect(state).toMatchObject({
      expectedVersion: "0.20.4",
      installedVersion: "0.20.4",
      inSync: true,
      binExists: true,
    });
  });
});
