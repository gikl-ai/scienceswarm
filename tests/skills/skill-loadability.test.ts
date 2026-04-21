import { readFileSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { describe, expect, it } from "vitest";

import { createBrainMcpServer } from "@/brain/mcp-server";

const DB_SKILLS = [
  {
    dir: "db-pubmed",
    tools: ["pubmed_fetch", "pubmed_search"],
    domains: ["eutils.ncbi.nlm.nih.gov"],
  },
  {
    dir: "db-arxiv",
    tools: ["arxiv_fetch", "arxiv_search"],
    domains: ["export.arxiv.org"],
  },
  {
    dir: "db-biorxiv",
    tools: ["biorxiv_fetch", "biorxiv_search"],
    domains: ["api.biorxiv.org"],
  },
  {
    dir: "db-crossref",
    tools: ["crossref_fetch", "crossref_search"],
    domains: ["api.crossref.org"],
  },
  {
    dir: "db-openalex",
    tools: ["openalex_fetch", "openalex_search"],
    domains: ["api.openalex.org"],
  },
  {
    dir: "db-semantic-scholar",
    tools: ["semantic_scholar_fetch", "semantic_scholar_search"],
    domains: ["api.semanticscholar.org"],
  },
  {
    dir: "db-materials-project",
    tools: ["materials_project_fetch", "materials_project_search"],
    domains: ["api.materialsproject.org"],
  },
  {
    dir: "db-pdb",
    tools: ["pdb_fetch", "pdb_search"],
    domains: ["data.rcsb.org", "search.rcsb.org"],
  },
  {
    dir: "db-chembl",
    tools: ["chembl_fetch", "chembl_search"],
    domains: ["www.ebi.ac.uk"],
  },
  {
    dir: "db-uniprot",
    tools: ["uniprot_fetch", "uniprot_search"],
    domains: ["rest.uniprot.org"],
  },
  {
    dir: "db-clinicaltrials",
    tools: ["clinicaltrials_fetch", "clinicaltrials_search"],
    domains: ["clinicaltrials.gov"],
  },
  {
    dir: "db-orcid",
    tools: ["orcid_fetch", "orcid_search"],
    domains: ["pub.orcid.org"],
  },
];

describe("database skill manifests", () => {
  it("load with network labels and declared MCP tools", () => {
    for (const skill of DB_SKILLS) {
      const raw = readFileSync(
        join(process.cwd(), ".openclaw/skills", skill.dir, "SKILL.md"),
        "utf-8",
      );
      const parsed = matter(raw);
      expect(parsed.data).toMatchObject({
        name: skill.dir,
        owner: "scienceswarm",
        runtime: "in-session",
        tier: "database",
        network: "external",
      });
      expect(parsed.data.tools).toEqual(skill.tools);
      expect(parsed.data.network_domains).toEqual(
        expect.arrayContaining(skill.domains),
      );
      expect(raw).not.toMatch(/\/Users\/|\/home\/|gikl-ai-scienceswarm|clawfarm|project-beta/i);
      expect(raw).not.toContain("hidden setup");
      expect(raw.length).toBeLessThan(8_000);
    }
  });

  it("registers the declared database tools on the MCP server entry point", () => {
    const server = createBrainMcpServer();
    const registeredTools = readPrivateRecord(server, "_registeredTools");
    const registered = Object.keys(registeredTools);
    const databaseToolPrefixes = [
      "pubmed",
      "arxiv",
      "biorxiv",
      "crossref",
      "openalex",
      "semantic_scholar",
      "materials_project",
      "pdb",
      "chembl",
      "uniprot",
      "clinicaltrials",
      "orcid",
    ];
    const databaseTools = registered
      .filter((name) => databaseToolPrefixes.some((prefix) => name.startsWith(`${prefix}_`)))
      .sort();
    const expectedDatabaseTools = DB_SKILLS.flatMap((skill) => skill.tools).sort();

    expect(databaseTools).toEqual(expectedDatabaseTools);
  });
});

function readPrivateRecord(source: object, key: string): Record<string, unknown> {
  const value: unknown = Reflect.get(source, key);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${key} to be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}
