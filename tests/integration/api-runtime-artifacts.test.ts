import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/runtime/artifacts/route";
import {
  __resetRuntimeApiServicesForTests,
  __setRuntimeApiServicesForTests,
} from "@/app/api/runtime/_shared";
import { createRuntimeEventStore } from "@/lib/runtime-hosts/events";
import { createRuntimeSessionStore } from "@/lib/runtime-hosts/sessions";

let tempRoot = "";

function request(body: unknown): Request {
  return new Request("http://localhost/api/runtime/artifacts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  const sessions = createRuntimeSessionStore();
  const events = createRuntimeEventStore({ sessions });
  __setRuntimeApiServicesForTests({
    sessionStore: sessions,
    eventStore: events,
    now: () => new Date("2026-04-22T13:00:00.000Z"),
  });
});

afterEach(async () => {
  __resetRuntimeApiServicesForTests();
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  tempRoot = "";
});

describe("POST /api/runtime/artifacts", () => {
  it("validates and records project-relative artifact provenance", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-artifact-api-"));
    await mkdir(path.join(tempRoot, "results"), { recursive: true });
    await writeFile(path.join(tempRoot, "results", "summary.md"), "# Summary\n");

    const response = await POST(request({
      action: "import",
      projectId: "project-alpha",
      hostId: "openhands",
      sessionId: "session-1",
      projectPolicy: "execution-ok",
      projectRoot: tempRoot,
      sourcePath: "results/summary.md",
      sourcePathKind: "project-relative",
      allowedRoots: [tempRoot],
      approvalState: "approved",
      importReason: "host-declared-artifact",
      promptHash: "prompt-hash-1",
      inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
      importedBy: "@tester",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.validation).toMatchObject({
      ok: true,
      mapping: { projectRelativePath: "results/summary.md" },
    });
    expect(body.artifact).toMatchObject({
      projectId: "project-alpha",
      sourceHostId: "openhands",
      sourceSessionId: "session-1",
      workspacePath: "results/summary.md",
      provenance: {
        promptHash: "prompt-hash-1",
        inputFileRefs: ["gbrain:wiki/notes/assay-summary"],
        approvalState: "approved",
      },
    });
    expect(body.writeback).toMatchObject({
      phaseStatus: "gbrain-writeback-pending",
      retry: false,
    });
  });

  it("reports explicit approval requirements for external artifact paths", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-artifact-api-"));
    const projectRoot = path.join(tempRoot, "project-alpha");
    const externalRoot = path.join(tempRoot, "external");
    const externalFile = path.join(externalRoot, "summary.md");
    await mkdir(externalRoot, { recursive: true });
    await writeFile(externalFile, "# External\n");

    const response = await POST(request({
      action: "validate",
      projectId: "project-alpha",
      hostId: "openhands",
      sessionId: "session-1",
      projectPolicy: "execution-ok",
      projectRoot,
      sourcePath: externalFile,
      sourcePathKind: "local-absolute",
      allowedRoots: [projectRoot, externalRoot],
      approvalState: "required",
      importReason: "user-selected-external-path",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.validation).toMatchObject({
      ok: false,
      reason: "approval-required",
      approvalRequired: true,
    });
    expect(body.artifact).toBeNull();
  });

  it("marks retry imports in the writeback response", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-artifact-api-"));

    const response = await POST(request({
      action: "retry",
      projectId: "project-alpha",
      hostId: "codex",
      sessionId: "session-1",
      projectPolicy: "cloud-ok",
      projectRoot: tempRoot,
      sourcePath: "figures/ratio-trend.svg",
      sourcePathKind: "project-relative",
      allowedRoots: [tempRoot],
      approvalState: "approved",
      importReason: "workspace-output-scan",
      promptHash: "prompt-hash-2",
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.writeback).toMatchObject({
      phaseStatus: "gbrain-writeback-pending",
      retry: true,
    });
  });
});
