import { describe, expect, it } from "vitest";

import {
  buildInstallPlan,
  buildServicePlan,
  detectBinarySource,
  inferDarwinHostArchitecture,
  isArchitectureCompatible,
  normalizeArchitecture,
  parseBinaryArchitecture,
} from "@/lib/ollama-install";

describe("ollama install planning", () => {
  it("normalizes host architecture aliases", () => {
    expect(normalizeArchitecture("x64")).toBe("x86_64");
    expect(normalizeArchitecture("aarch64")).toBe("arm64");
  });

  it("parses universal and single-arch binaries", () => {
    expect(parseBinaryArchitecture("Mach-O 64-bit executable arm64")).toBe("arm64");
    expect(parseBinaryArchitecture("Mach-O 64-bit executable x86_64")).toBe("x86_64");
    expect(
      parseBinaryArchitecture("Mach-O universal binary with 2 architectures: [x86_64] [arm64]"),
    ).toBe("universal");
  });

  it("marks Intel binaries as incompatible on Apple Silicon", () => {
    expect(isArchitectureCompatible("arm64", "x86_64")).toBe(false);
    expect(isArchitectureCompatible("arm64", "universal")).toBe(true);
  });

  it("prefers native Homebrew installs on Apple Silicon", () => {
    const plan = buildInstallPlan({
      hostPlatform: "darwin",
      hostArchitecture: "arm64",
      preferredBrewPath: "/opt/homebrew/bin/brew",
    });

    expect(plan.preferredInstaller).toBe("homebrew");
    expect(plan.installCommand).toBe("'/opt/homebrew/bin/brew' install ollama");
    expect(plan.installHint).toContain("native arm64 Ollama build");
  });

  it("refuses Intel Homebrew guidance on Apple Silicon when native Homebrew is missing", () => {
    const plan = buildInstallPlan({
      hostPlatform: "darwin",
      hostArchitecture: "arm64",
      preferredBrewPath: null,
    });

    expect(plan.preferredInstaller).toBe("download");
    expect(plan.installCommand).toBeNull();
    expect(plan.installHint).toContain("native Homebrew was not found");
    expect(plan.installHint).toContain("Intel Homebrew");
  });

  it("detects Apple Silicon hardware even when the Node process is translated under Rosetta", () => {
    expect(
      inferDarwinHostArchitecture({
        processArchitecture: "x86_64",
        hardwareArm64Support: "1",
        processTranslated: "1",
      }),
    ).toBe("arm64");
  });

  it("classifies app and Homebrew binaries from their real install location", () => {
    expect(
      detectBinarySource(
        "/Applications/Ollama.app/Contents/Resources/ollama",
        "/Applications/Ollama.app/Contents/Resources/ollama",
      ),
    ).toBe("app");
    expect(
      detectBinarySource(
        "/usr/local/bin/ollama",
        "/opt/homebrew/Cellar/ollama/0.7.0/bin/ollama",
      ),
    ).toBe("homebrew");
  });

  it("uses direct launch commands for app installs even when Homebrew is present", () => {
    const plan = buildServicePlan({
      hostPlatform: "darwin",
      preferredBrewPath: "/opt/homebrew/bin/brew",
      systemctlAvailable: false,
      binaryPath: "/Applications/Ollama.app/Contents/Resources/ollama",
      binarySource: "app",
    });

    expect(plan.serviceManager).toBe("direct");
    expect(plan.startCommand).toContain("/Applications/Ollama.app/Contents/Resources/ollama");
    expect(plan.stopCommand).toBe("pkill -f 'ollama serve'");
  });

  it("does not emit POSIX direct commands on unsupported hosts", () => {
    const plan = buildServicePlan({
      hostPlatform: "other",
      preferredBrewPath: null,
      systemctlAvailable: false,
      binaryPath: "ollama",
    });

    expect(plan.startCommand).toBeNull();
    expect(plan.stopCommand).toBeNull();
  });
});
