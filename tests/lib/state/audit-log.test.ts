import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { appendAuditEvent, getAuditLogPath } from "@/lib/state/audit-log";

const ROOT = join(tmpdir(), "scienceswarm-state-audit-log");

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("audit-log", () => {
  it("appends jsonl audit events", async () => {
    await appendAuditEvent(
      {
        ts: "2026-04-08T00:00:00.000Z",
        kind: "policy",
        action: "deny",
        route: "/api/chat",
        outcome: "blocked",
        privacy: "local-only",
      },
      ROOT,
    );

    const log = readFileSync(getAuditLogPath(ROOT), "utf-8").trim();
    const event = JSON.parse(log);
    expect(event.action).toBe("deny");
    expect(event.privacy).toBe("local-only");
  });
});
