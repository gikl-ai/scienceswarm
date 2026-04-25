import { describe, expect, it } from "vitest";

import {
  expandRuntimeMcpToolNames,
  resolveRuntimeMcpToolProfile,
  runtimeMcpToolAllowedForHost,
} from "@/lib/runtime-hosts/mcp/tool-profiles";
import { requireRuntimeHostProfile } from "@/lib/runtime-hosts/registry";

describe("runtime MCP tool profiles", () => {
  it("expands registry aliases into concrete runtime MCP tools", () => {
    expect(
      expandRuntimeMcpToolNames([
        "gbrain_read",
        "gbrain_write",
        "provenance_log",
        "project_workspace_read",
      ]),
    ).toEqual([
      "gbrain_search",
      "gbrain_read",
      "gbrain_capture",
      "provenance_log",
      "project_workspace_read",
    ]);
  });

  it("always exposes baseline gbrain/provenance tools for runtime hosts", () => {
    const profile = resolveRuntimeMcpToolProfile("codex");

    expect(profile.always).toEqual([
      "gbrain_search",
      "gbrain_read",
      "gbrain_capture",
      "provenance_log",
    ]);
    expect(profile.allowedTools).toEqual(
      expect.arrayContaining([
        "gbrain_search",
        "gbrain_read",
        "gbrain_capture",
        "provenance_log",
      ]),
    );
  });

  it("exposes workspace tools only when the host profile does not suppress them", () => {
    const claudeCode = resolveRuntimeMcpToolProfile("claude-code");
    expect(
      claudeCode.allowedTools,
    ).toEqual(expect.arrayContaining(["project_workspace_read", "artifact_import"]));

    const openHands = resolveRuntimeMcpToolProfile("openhands");
    expect(openHands.allowedTools).toContain("artifact_import");
    expect(openHands.suppressed).toContain("project_workspace_read");
    expect(openHands.allowedTools).not.toContain("project_workspace_read");
  });

  it("adds claude-code always-exposed hosted tools in the always list", () => {
    const profile = resolveRuntimeMcpToolProfile("claude-code");

    expect(profile.always).toContain("openhands_delegate");
    expect(profile.allowedTools).toContain("openhands_delegate");
  });

  it("uses the host profile as the server-side allowlist", () => {
    const host = requireRuntimeHostProfile("openhands");

    expect(
      runtimeMcpToolAllowedForHost({
        host,
        toolName: "project_workspace_read",
      }),
    ).toBe(false);
    expect(
      runtimeMcpToolAllowedForHost({
        host,
        toolName: "gbrain_capture",
      }),
    ).toBe(true);
  });

});
