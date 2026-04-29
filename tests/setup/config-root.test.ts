import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveSetupConfigRoot,
  resolveSetupEnvPath,
} from "@/lib/setup/config-root";

describe("setup config root", () => {
  it("defaults mutable setup config to the current working directory", () => {
    expect(resolveSetupConfigRoot({}, "/tmp/scienceswarm-app")).toBe(
      "/tmp/scienceswarm-app",
    );
    expect(resolveSetupEnvPath({}, "/tmp/scienceswarm-app")).toBe(
      path.join("/tmp/scienceswarm-app", ".env"),
    );
  });

  it("honors SCIENCESWARM_CONFIG_ROOT for packaged desktop runtimes", () => {
    expect(
      resolveSetupEnvPath(
        { SCIENCESWARM_CONFIG_ROOT: "/tmp/ScienceSwarm User Data" },
        "/Volumes/ScienceSwarm.app/Contents/Resources/app.asar.unpacked/.next/standalone",
      ),
    ).toBe(path.join("/tmp/ScienceSwarm User Data", ".env"));
  });
});
