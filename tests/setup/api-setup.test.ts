import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseEnvFile } from "@/lib/setup/env-writer";

async function readEnv(repoRoot: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, ".env"), "utf8");
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/setup", () => {
  let repoRoot: string;
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "api-setup-"));
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "api-setup-home-"));
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

  it("rejects non-local requests before writing .env", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://example.com/api/setup", {
        openaiApiKey: "sk-real-abc",
      }),
    );

    expect(res.status).toBe(403);
    await expect(
      fs.stat(path.join(repoRoot, ".env")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves a valid body and writes values to .env", async () => {
    const dir = path.join(tmpHome, "data");
    await fs.mkdir(dir);

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "sk-real-abc",
        scienceswarmDir: dir,
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      restartRequired: boolean;
      redirect: string;
    };
    expect(body.ok).toBe(true);
    expect(body.restartRequired).toBe(true);
    expect(body.redirect).toBe("/dashboard/settings");

    // Round-trip: re-read the file and confirm values are present.
    const contents = await readEnv(repoRoot);
    const doc = parseEnvFile(contents);
    const entries = doc.lines.filter(
      (line): line is { type: "entry"; key: string; value: string; raw: string } =>
        line.type === "entry",
    );
    const map = new Map(entries.map((entry) => [entry.key, entry.value]));
    expect(map.get("OPENAI_API_KEY")).toBe("sk-real-abc");
    expect(map.get("SCIENCESWARM_DIR")).toBe(dir);
  });

  it("normalizes scienceswarmDir to an absolute path before writing", async () => {
    await fs.mkdir(path.join(repoRoot, "relative-parent"), { recursive: true });

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "sk-real-abc",
        scienceswarmDir: "./relative-parent/data",
      }),
    );

    expect(res.status).toBe(200);
    const contents = await readEnv(repoRoot);
    expect(contents).toContain(
      `SCIENCESWARM_DIR=${path.join(repoRoot, "relative-parent", "data")}`,
    );
  });

  it("expands ~/ in scienceswarmDir before writing", async () => {
    await fs.mkdir(path.join(tmpHome, "expanded-home"), { recursive: true });

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "sk-real-abc",
        scienceswarmDir: "~/expanded-home/data",
      }),
    );

    expect(res.status).toBe(200);
    const contents = await readEnv(repoRoot);
    expect(contents).toContain(
      `SCIENCESWARM_DIR=${path.join(tmpHome, "expanded-home", "data")}`,
    );
  });

  it("writes all optional secret fields when provided", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "sk-real",
        telegramBotToken: "tg-token-xyz",
        googleClientId: "gid",
        googleClientSecret: "gsecret",
        githubId: "ghid",
        githubSecret: "ghsecret",
      }),
    );
    expect(res.status).toBe(200);

    const doc = parseEnvFile(await readEnv(repoRoot));
    const map = new Map(
      doc.lines
        .filter(
          (line): line is { type: "entry"; key: string; value: string; raw: string } =>
            line.type === "entry",
        )
        .map((entry) => [entry.key, entry.value]),
    );
    expect(map.get("OPENAI_API_KEY")).toBe("sk-real");
    expect(map.get("TELEGRAM_BOT_TOKEN")).toBe("tg-token-xyz");
    expect(map.get("GOOGLE_CLIENT_ID")).toBe("gid");
    expect(map.get("GOOGLE_CLIENT_SECRET")).toBe("gsecret");
    expect(map.get("GITHUB_ID")).toBe("ghid");
    expect(map.get("GITHUB_SECRET")).toBe("ghsecret");
  });

  it("returns 400 with field errors for a placeholder OpenAI key", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "sk-proj-REPLACE-ME-etc",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      fields: Record<string, { state: string; reason?: string }>;
    };
    expect(body.fields.openaiApiKey?.state).toBe("placeholder");
    // Ensure we never echo the actual value anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("sk-proj-REPLACE-ME-etc");
  });

  it("returns 400 with field errors for an invalid OpenAI key (wrong prefix)", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "gh-ghp_accidental_github_token_12345",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      fields: Record<string, { state: string }>;
    };
    expect(body.fields.openaiApiKey?.state).toBe("invalid");
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("gh-ghp_accidental_github_token_12345");
  });

  it("returns 400 for unknown fields in request body", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "sk-real",
        bogusField: "oops",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      unknownFields: string[];
    };
    expect(body.unknownFields).toContain("bogusField");
    // File must not have been written.
    await expect(readEnv(repoRoot)).rejects.toThrow();
  });

  it("returns 400 when the JSON body is malformed", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      new Request("http://localhost/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json-at-all",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is an array", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", ["foo"]),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when a field has the wrong type", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: 12345 as unknown as string,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("setting scienceswarmDir to empty string removes the SCIENCESWARM_DIR line", async () => {
    // Seed .env with an existing SCIENCESWARM_DIR.
    const dir = path.join(tmpHome, "data");
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      `OPENAI_API_KEY=sk-real\nSCIENCESWARM_DIR=${dir}\n`,
      "utf8",
    );

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        scienceswarmDir: "",
      }),
    );
    expect(res.status).toBe(200);

    const contents = await readEnv(repoRoot);
    expect(contents).not.toMatch(/SCIENCESWARM_DIR=/);
    // Other keys preserved.
    expect(contents).toMatch(/OPENAI_API_KEY=sk-real/);
  });

  it("omitting a field leaves its existing value untouched", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      "OPENAI_API_KEY=sk-original\nTELEGRAM_BOT_TOKEN=tg-original\n",
      "utf8",
    );

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "sk-new",
        // telegramBotToken omitted
      }),
    );
    expect(res.status).toBe(200);

    const contents = await readEnv(repoRoot);
    expect(contents).toMatch(/OPENAI_API_KEY=sk-new/);
    expect(contents).toMatch(/TELEGRAM_BOT_TOKEN=tg-original/);
  });

  it("sending empty string for a non-scienceswarmDir field is a no-op (preserves secret)", async () => {
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      "TELEGRAM_BOT_TOKEN=tg-original\n",
      "utf8",
    );

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        telegramBotToken: "",
      }),
    );
    expect(res.status).toBe(200);

    const contents = await readEnv(repoRoot);
    // Original value preserved; empty string did not wipe it.
    expect(contents).toMatch(/TELEGRAM_BOT_TOKEN=tg-original/);
  });

  it("leaving openaiApiKey empty while setting another field keeps the existing OPENAI_API_KEY intact", async () => {
    // Regression guard for the redacted-prefill flow: the /setup page
    // loads with an empty OpenAI key input when a secret was already
    // set on disk (the redacted sentinel never reaches the input).
    // If the user saves a change to a different field without
    // retyping the key, the server must NOT wipe the existing
    // OPENAI_API_KEY. Empty secret fields mean "don't touch"; only
    // scienceswarmDir treats "" as the remove sentinel.
    const dir = path.join(tmpHome, "data");
    await fs.mkdir(dir);
    await fs.writeFile(
      path.join(repoRoot, ".env"),
      "OPENAI_API_KEY=sk-existing-real-key\nTELEGRAM_BOT_TOKEN=tg-old\n",
      "utf8",
    );

    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        // User is updating telegram only; OpenAI key input was blank
        // because the UI hid the redacted value.
        openaiApiKey: "",
        scienceswarmDir: dir,
        telegramBotToken: "tg-new",
      }),
    );
    expect(res.status).toBe(200);

    const contents = await readEnv(repoRoot);
    // Existing key must still be present, untouched.
    expect(contents).toMatch(/OPENAI_API_KEY=sk-existing-real-key/);
    expect(contents).toMatch(/TELEGRAM_BOT_TOKEN=tg-new/);
    expect(contents).toMatch(/SCIENCESWARM_DIR=/);
  });

  it("response includes restartRequired:true on success", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "sk-real",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restartRequired: boolean };
    expect(body.restartRequired).toBe(true);
  });

  it("never echoes secret values in the success response", async () => {
    const { POST } = await import("@/app/api/setup/route");
    const res = await POST(
      jsonRequest("http://localhost/api/setup", {
        openaiApiKey: "sk-top-secret-42",
        telegramBotToken: "tg-very-secret",
      }),
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("sk-top-secret-42");
    expect(raw).not.toContain("tg-very-secret");
  });
});
