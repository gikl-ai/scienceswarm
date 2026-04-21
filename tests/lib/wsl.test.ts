import { describe, expect, it } from "vitest";

import { isMountedWindowsPath, isWslEnvironment } from "@/lib/wsl";

describe("wsl helpers", () => {
  it("detects WSL from environment variables", () => {
    expect(
      isWslEnvironment({
        platform: "linux",
        release: "6.6.87.2-microsoft-standard-WSL2",
        env: {
          WSL_INTEROP: "/run/WSL/123_interop",
        } as unknown as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it("detects WSL from the kernel release string", () => {
    expect(
      isWslEnvironment({
        platform: "linux",
        release: "5.15.167.4-microsoft-standard-WSL2",
        env: {} as unknown as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it("does not misclassify ordinary Linux as WSL", () => {
    expect(
      isWslEnvironment({
        platform: "linux",
        release: "6.8.0-60-generic",
        env: {} as unknown as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });

  it("recognizes mounted Windows paths", () => {
    expect(isMountedWindowsPath("/mnt/c/Users/tester/project-alpha")).toBe(
      true,
    );
    expect(isMountedWindowsPath("/mnt/d/data")).toBe(true);
    expect(isMountedWindowsPath("/home/tester/scienceswarm")).toBe(false);
  });
});
