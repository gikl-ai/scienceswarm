/**
 * Extended POST /api/setup coverage for the PR B stage B1 additions:
 * brain profile fields, LLM provider toggle, agent backend pick, and
 * Ollama model selection.
 *
 * Follows the isolation pattern from `api-setup.test.ts` — each test
 * gets a freshly-mkdtemp'd `repoRoot` and a throwaway `$HOME`, then
 * `process.cwd` is monkey-patched to return the tmp root so the
 * handler reads and writes our scratch `.env` rather than the live
 * project's copy.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseEnvFile } from "@/lib/setup/env-writer";
import { ENV_FILE_NAME } from "../helpers/env-file";

const configureOpenClawModelMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/openclaw/model-config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/openclaw/model-config")>();
  return {
    ...actual,
    configureOpenClawModel: configureOpenClawModelMock,
  };
});

async function readEnv(repoRoot: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, ENV_FILE_NAME), "utf8");
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function entriesMap(contents: string): Map<string, string> {
  const doc = parseEnvFile(contents);
  return new Map(
    doc.lines
      .filter(
        (line): line is { type: "entry"; key: string; value: string; raw: string } =>
          line.type === "entry",
      )
      .map((entry) => [entry.key, entry.value]),
  );
}

describe("POST /api/setup — extended schema (PR B stage B1)", () => {
  let repoRoot: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    configureOpenClawModelMock.mockReset();
    configureOpenClawModelMock.mockResolvedValue(true);
    repoRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "api-setup-extended-"),
    );
    tmpHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "api-setup-extended-home-"),
    );
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(repoRoot);
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
  });

  it("writes BRAIN_PROFILE_NAME/FIELD/INSTITUTION from the brainProfile* fields", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        brainProfileName: "Dr. Ada Lovelace",
        brainProfileField: "Analytical Engines",
        brainProfileInstitution: "London Mathematical Society",
      }),
    );

    expect(res.status).toBe(200);

    const map = entriesMap(await readEnv(repoRoot));
    expect(map.get("BRAIN_PROFILE_NAME")).toBe("Dr. Ada Lovelace");
    expect(map.get("BRAIN_PROFILE_FIELD")).toBe("Analytical Engines");
    expect(map.get("BRAIN_PROFILE_INSTITUTION")).toBe(
      "London Mathematical Society",
    );
  });

  it("writes BRAIN_PRESET when brainPreset is provided", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        brainPreset: "generic_scientist",
      }),
    );

    expect(res.status).toBe(200);

    const map = entriesMap(await readEnv(repoRoot));
    expect(map.get("BRAIN_PRESET")).toBe("generic_scientist");
  });

  it("writes LLM_PROVIDER=local when llmProvider is 'local'", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        llmProvider: "local",
      }),
    );
    expect(res.status).toBe(200);

    const map = entriesMap(await readEnv(repoRoot));
    expect(map.get("LLM_PROVIDER")).toBe("local");
  });

  it("writes LLM_PROVIDER=openai when llmProvider is 'openai'", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        llmProvider: "openai",
      }),
    );
    expect(res.status).toBe(200);

    const map = entriesMap(await readEnv(repoRoot));
    expect(map.get("LLM_PROVIDER")).toBe("openai");
  });

  it("returns 400 with a helpful error when llmProvider is not in the closed enum", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        llmProvider: "invalid",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fields: Record<string, { state: string; reason?: string }>;
    };
    expect(body.fields.llmProvider?.state).toBe("invalid");
    // The error must name the accepted tokens so the UI / CLI user
    // can self-correct without opening the source.
    expect(body.fields.llmProvider?.reason).toMatch(/openai/);
    expect(body.fields.llmProvider?.reason).toMatch(/local/);

    // File must not have been written.
    await expect(readEnv(repoRoot)).rejects.toThrow();
  });

  it("writes AGENT_BACKEND=openclaw when agentBackend is 'openclaw'", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        agentBackend: "openclaw",
      }),
    );
    expect(res.status).toBe(200);

    const map = entriesMap(await readEnv(repoRoot));
    expect(map.get("AGENT_BACKEND")).toBe("openclaw");
  });

  it("accepts nanoclaw as a valid agentBackend value", async () => {
    const { POST } = await import("@/app/api/setup/route");

    const resNano = await POST(
      jsonRequest("http://localhost/api/setup", {
        agentBackend: "nanoclaw",
      }),
    );
    expect(resNano.status).toBe(200);
    expect(entriesMap(await readEnv(repoRoot)).get("AGENT_BACKEND")).toBe(
      "nanoclaw",
    );
  });

  it("returns 400 when agentBackend is not in the closed enum", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        agentBackend: "none",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      fields: Record<string, { state: string; reason?: string }>;
    };
    expect(body.fields.agentBackend?.state).toBe("invalid");
    expect(body.fields.agentBackend?.reason).toMatch(/openclaw/);
    expect(body.fields.agentBackend?.reason).toMatch(/nanoclaw/);
    expect(body.fields.agentBackend?.reason).not.toMatch(/none/);

    await expect(readEnv(repoRoot)).rejects.toThrow();
  });

  it("writes OLLAMA_MODEL when ollamaModel is provided", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        ollamaModel: "llama3.2",
      }),
    );
    expect(res.status).toBe(200);

    const map = entriesMap(await readEnv(repoRoot));
    expect(map.get("OLLAMA_MODEL")).toBe("llama3.2");
  });

  it("combines brain profile + llmProvider + agentBackend in a single save", async () => {
    // Regression guard: the /setup UI writes multiple fields at once;
    // the handler must accept them all in a single payload and the
    // resulting .env must contain every write.
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        brainProfileName: "Grace Hopper",
        brainProfileField: "Compiler Design",
        brainProfileInstitution: "U.S. Navy",
        llmProvider: "openai",
        agentBackend: "openclaw",
        ollamaModel: "llama3.2",
      }),
    );
    expect(res.status).toBe(200);

    const map = entriesMap(await readEnv(repoRoot));
    expect(map.get("BRAIN_PROFILE_NAME")).toBe("Grace Hopper");
    expect(map.get("BRAIN_PROFILE_FIELD")).toBe("Compiler Design");
    expect(map.get("BRAIN_PROFILE_INSTITUTION")).toBe("U.S. Navy");
    expect(map.get("LLM_PROVIDER")).toBe("openai");
    expect(map.get("AGENT_BACKEND")).toBe("openclaw");
    expect(map.get("OLLAMA_MODEL")).toBe("llama3.2");
  });

  it("syncs OpenClaw to the saved local Ollama model when setup selects local OpenClaw", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        llmProvider: "local",
        agentBackend: "openclaw",
        ollamaModel: "gemma4:latest",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openClawModelSync?: { ok: boolean; model?: string };
    };

    expect(configureOpenClawModelMock).toHaveBeenCalledWith(
      "ollama/gemma4:latest",
      "local",
      { timeoutMs: 10_000 },
    );
    expect(body.openClawModelSync).toEqual({
      ok: true,
      model: "ollama/gemma4:latest",
    });
  });

  it("keeps setup save successful when OpenClaw model sync fails", async () => {
    configureOpenClawModelMock.mockRejectedValueOnce(new Error("openclaw unavailable"));

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        llmProvider: "local",
        agentBackend: "openclaw",
        ollamaModel: "gemma4:latest",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      openClawModelSync?: { ok: boolean; model?: string };
    };
    expect(body.openClawModelSync).toEqual({ ok: false });

    const env = await readEnv(repoRoot);
    const map = entriesMap(env);
    expect(map.get("LLM_PROVIDER")).toBe("local");
    expect(map.get("AGENT_BACKEND")).toBe("openclaw");
    expect(map.get("OLLAMA_MODEL")).toBe("gemma4:latest");
  });

  it("empty string on an enum / non-clearable field is a no-op (preserves the existing value)", async () => {
    // Empty-value semantics for fields NOT in EMPTY_MEANS_REMOVE must
    // preserve the existing entry: the UI may send "" when the input
    // was left blank, and that must not wipe the existing env entry.
    await fs.writeFile(
      path.join(repoRoot, ENV_FILE_NAME),
      "LLM_PROVIDER=openai\n",
      "utf8",
    );

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        llmProvider: "",
      }),
    );
    expect(res.status).toBe(200);

    const map = entriesMap(await readEnv(repoRoot));
    expect(map.get("LLM_PROVIDER")).toBe("openai");
  });

  it("empty string on brain-profile fields removes them from .env", async () => {
    // EMPTY_MEANS_REMOVE semantics: the UI allows a user to clear a
    // previously-saved brain-profile entry by submitting an empty
    // string. The server must drop those keys from .env entirely
    // rather than silently keeping the stale value.
    await fs.writeFile(
      path.join(repoRoot, ENV_FILE_NAME),
      [
        "OPENAI_API_KEY=sk-keep-me",
        "BRAIN_PROFILE_NAME=Dr. Ada Lovelace",
        "BRAIN_PROFILE_FIELD=Analytical Engines",
        "BRAIN_PROFILE_INSTITUTION=London Mathematical Society",
        "",
      ].join("\n"),
      "utf8",
    );

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        brainProfileName: "",
        brainProfileField: "",
        brainProfileInstitution: "",
      }),
    );
    expect(res.status).toBe(200);

    const contents = await readEnv(repoRoot);
    // All three brain-profile keys must be gone.
    expect(contents).not.toMatch(/^BRAIN_PROFILE_NAME=/m);
    expect(contents).not.toMatch(/^BRAIN_PROFILE_FIELD=/m);
    expect(contents).not.toMatch(/^BRAIN_PROFILE_INSTITUTION=/m);
    // Unrelated secret preserved.
    expect(contents).toMatch(/OPENAI_API_KEY=sk-keep-me/);
  });

  it("response redirect targets the setup dashboard destination", async () => {
    // The frontend sends the user to /dashboard/settings after restart,
    // so the API redirect field must match for any automation that
    // follows the server pointer.
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        brainProfileName: "Ada",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      restartRequired: boolean;
      redirect: string;
    };
    expect(body.redirect).toBe("/dashboard/settings");
  });

  it("still rejects unknown fields after the schema extension", async () => {
    // Regression guard for the unknown-field-rejection contract: adding
    // new accepted fields must not soften the typo-catcher behavior.
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        brainProfileName: "Ada",
        foo: "bar",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      unknownFields: string[];
    };
    expect(body.unknownFields).toContain("foo");

    // File must not have been written.
    await expect(readEnv(repoRoot)).rejects.toThrow();
  });
});
