import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activateOpenClawAgentBackend } from "@/lib/openclaw/agent-backend";

describe("activateOpenClawAgentBackend", () => {
  let tmpRoot: string;
  let envPath: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-backend-"));
    envPath = path.join(tmpRoot, ".env");
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("replaces a disabled agent backend with OpenClaw", async () => {
    await fs.writeFile(
      envPath,
      [
        "# User settings",
        "AGENT_BACKEND=none",
        "LLM_PROVIDER=local",
        "OLLAMA_MODEL=gemma4:latest",
      ].join("\n"),
      "utf-8",
    );

    await activateOpenClawAgentBackend(envPath);

    const saved = await fs.readFile(envPath, "utf-8");
    expect(saved).toContain("# User settings");
    expect(saved).toContain("AGENT_BACKEND=openclaw");
    expect(saved).toContain("OLLAMA_API_KEY=ollama-local");
    expect(saved).not.toContain("AGENT_BACKEND=none");
    expect(saved).toContain("LLM_PROVIDER=local");
  });

  it("preserves an existing local Ollama sentinel", async () => {
    await fs.writeFile(
      envPath,
      [
        "AGENT_BACKEND=none",
        "LLM_PROVIDER=local",
        "OLLAMA_API_KEY=custom-local-marker",
      ].join("\n"),
      "utf-8",
    );

    await activateOpenClawAgentBackend(envPath);

    const saved = await fs.readFile(envPath, "utf-8");
    expect(saved).toContain("AGENT_BACKEND=openclaw");
    expect(saved).toContain("OLLAMA_API_KEY=custom-local-marker");
  });

  it("creates the backend entry when .env does not exist yet", async () => {
    await activateOpenClawAgentBackend(envPath);

    await expect(fs.readFile(envPath, "utf-8")).resolves.toBe("AGENT_BACKEND=openclaw");
  });
});
