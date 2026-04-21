import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/setup/validate-dir", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/setup/validate-dir", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "api-setup-validate-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });

  afterEach(async () => {
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
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it("returns the resolved absolute path for a valid value", async () => {
    const existing = path.join(tmpHome, "workspace");
    await fs.mkdir(existing, { recursive: true });

    const { POST } = await import("@/app/api/setup/validate-dir/route");
    const res = await POST(jsonRequest({ value: "~/workspace" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolvedPath: string | null;
      status: { state: string };
    };
    expect(body.resolvedPath).toBe(existing);
    expect(body.status.state).toBe("ok");
  });

  it("surfaces placeholder status without mutating anything", async () => {
    const { POST } = await import("@/app/api/setup/validate-dir/route");
    const res = await POST(
      jsonRequest({ value: "/path/to/scienceswarm-data" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: { state: string; reason?: string };
    };
    expect(body.status.state).toBe("placeholder");
    expect(body.status.reason).toMatch(/placeholder|example/i);
  });

  it("returns 400 when the request body is malformed", async () => {
    const { POST } = await import("@/app/api/setup/validate-dir/route");
    const res = await POST(
      new Request("http://localhost/api/setup/validate-dir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );

    expect(res.status).toBe(400);
  });
});
