import { describe, expect, it } from "vitest";

import {
  GBRAIN_STRUCTURAL_COMMIT,
  probeGbrainCapabilities,
  type GbrainSchemaSnapshot,
} from "@/brain/gbrain-capabilities";
import type { ScienceSwarmGbrainPackageState } from "@/lib/gbrain/source-of-truth";

function packageState(
  overrides: Partial<ScienceSwarmGbrainPackageState> = {},
): ScienceSwarmGbrainPackageState {
  return {
    repoRoot: "/tmp/scienceswarm",
    lockfilePath: "/tmp/scienceswarm/package-lock.json",
    packagePath: "/tmp/scienceswarm/node_modules/gbrain/package.json",
    expectedVersion: "0.21.0",
    expectedResolved: `git+ssh://git@github.com/garrytan/gbrain.git#${GBRAIN_STRUCTURAL_COMMIT}`,
    installedVersion: "0.21.0",
    installedName: "gbrain",
    binPath: "/tmp/scienceswarm/node_modules/.bin/gbrain",
    binExists: true,
    inSync: true,
    ...overrides,
  };
}

function upgradedSchema(
  overrides: Partial<GbrainSchemaSnapshot> = {},
): GbrainSchemaSnapshot {
  return {
    schemaVersion: 29,
    fields: [
      { table: "sources", column: "chunker_version" },
      { table: "content_chunks", column: "symbol_name" },
      { table: "content_chunks", column: "symbol_type" },
      { table: "content_chunks", column: "symbol_name_qualified" },
      { table: "content_chunks", column: "parent_symbol_path" },
      { table: "content_chunks", column: "search_vector" },
      { table: "code_edges_chunk", column: "from_chunk_id" },
      { table: "code_edges_chunk", column: "to_chunk_id" },
      { table: "code_edges_symbol", column: "to_symbol_qualified" },
    ],
    sourceChunkerVersions: ["4", null],
    ...overrides,
  };
}

const structuralHelp = [
  "code-def <symbol>",
  "code-refs <symbol>",
  "code-callers <symbol>",
  "code-callees <symbol>",
  "reindex-code [--source id]",
].join("\n");

describe("probeGbrainCapabilities", () => {
  it("keeps old or local brains degraded until every structural gate is proven", async () => {
    const capabilities = await probeGbrainCapabilities({
      packageState: packageState({
        expectedVersion: "0.20.4",
        expectedResolved: "git+ssh://git@github.com/garrytan/gbrain.git#11abb24ddd2209f8622870c2e48dc9ef050ad749",
        installedVersion: "0.20.4",
      }),
      doctor: {
        ok: false,
        schemaVersion: 23,
        rawStatus: "degraded",
        message: "Version 23, latest is 29.",
      },
      schema: upgradedSchema({
        schemaVersion: 23,
        fields: [{ table: "sources", column: "id" }],
        sourceChunkerVersions: ["3"],
      }),
      helpText: "get put search",
    });

    expect(capabilities.structuralNavigationAvailable).toBe(false);
    expect(capabilities.package.ready).toBe(false);
    expect(capabilities.schema.requiredFieldsPresent).toBe(false);
    expect(capabilities.operations.missing).toEqual([
      "code-def",
      "code-refs",
      "code-callers",
      "code-callees",
      "reindex-code",
    ]);
    expect(capabilities.chunker.supported).toBe(false);
    expect(capabilities.reindex.status).toBe("unavailable");
    expect(capabilities.blockers.length).toBeGreaterThan(0);
  });

  it("reports structural capability only for upgraded package, schema, operations, and chunker state", async () => {
    const capabilities = await probeGbrainCapabilities({
      packageState: packageState(),
      doctor: {
        ok: true,
        schemaVersion: 29,
        rawStatus: "ready",
        message: "Version 29 (latest: 29)",
      },
      schema: upgradedSchema(),
      helpText: structuralHelp,
    });

    expect(capabilities.structuralNavigationAvailable).toBe(true);
    expect(capabilities.package.ready).toBe(true);
    expect(capabilities.schema.requiredFieldsPresent).toBe(true);
    expect(capabilities.operations.missing).toEqual([]);
    expect(capabilities.chunker.supported).toBe(true);
    expect(capabilities.reindex.status).toBe("not-required");
    expect(capabilities.blockers).toEqual([]);
  });

  it("requires explicit reindex status when sources report older chunker metadata", async () => {
    const capabilities = await probeGbrainCapabilities({
      packageState: packageState(),
      doctor: {
        ok: true,
        schemaVersion: 29,
        rawStatus: "ready",
        message: "Version 29 (latest: 29)",
      },
      schema: upgradedSchema({ sourceChunkerVersions: ["3", "4"] }),
      helpText: structuralHelp,
    });

    expect(capabilities.structuralNavigationAvailable).toBe(false);
    expect(capabilities.chunker.supported).toBe(false);
    expect(capabilities.reindex.status).toBe("required");
    expect(capabilities.reindex.reason).toContain("explicit maintenance path");
  });

  it("smokes the installed package and CLI operation probe without reading a user brain", async () => {
    const capabilities = await probeGbrainCapabilities({
      doctor: {
        ok: false,
        schemaVersion: null,
        rawStatus: "unknown",
        message: "schema intentionally skipped in package smoke",
      },
      schema: null,
    });

    expect(capabilities.package.expectedVersion).toBe("0.21.0");
    expect(capabilities.package.installedVersion).toBe("0.21.0");
    expect(capabilities.package.ready).toBe(true);
    expect(capabilities.operations.missing).toEqual([]);
    expect(capabilities.structuralNavigationAvailable).toBe(false);
    expect(capabilities.schema.rawStatus).toBe("unknown");
  });
});
