import { ensureBrainStoreReady, getBrainStore } from "@/brain/store";
import {
  isSha256Hex,
  type GbrainPageFileRef,
} from "@/brain/gbrain-data-contracts";

type QueryResultRow = Record<string, unknown>;

interface QueryableDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
}

interface QueryableDbError {
  code?: unknown;
  message?: unknown;
}

const unsupportedWorkspaceFilesTables = new WeakSet<QueryableDb>();

export interface ProjectPageSummary {
  path: string;
  type: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

export interface ProjectWorkspaceFileEntry {
  workspacePath: string;
  pagePath: string;
  pageType: string;
  pageTitle: string;
  pageFrontmatter: Record<string, unknown>;
  ref: GbrainPageFileRef;
  updatedAt: string | null;
}

const PAGE_SUMMARY_LIMIT = 5000;
const WORKSPACE_FILE_LIMIT = 100_000;

function parseFrontmatter(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getQueryableDb(): QueryableDb | null {
  try {
    const store = getBrainStore() as {
      engine?: { db?: QueryableDb };
    };
    const db = store.engine?.db;
    return db && typeof db.query === "function" ? db : null;
  } catch {
    return null;
  }
}

function isMissingRelationError(error: unknown, relation: string): boolean {
  const candidate = error as QueryableDbError | null;
  const message =
    typeof candidate?.message === "string" ? candidate.message : "";
  return candidate?.code === "42P01"
    || message.includes(`relation "${relation}" does not exist`);
}

function projectMatchSql(alias: string): string {
  return `(
    ${alias}.frontmatter->>'project' = $1
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(${alias}.frontmatter->'projects') = 'array'
            THEN ${alias}.frontmatter->'projects'
          ELSE '[]'::jsonb
        END
      ) AS project_slug(value)
      WHERE project_slug.value = $1
    )
  )`;
}

export async function listProjectPageSummariesFast(
  project: string,
): Promise<ProjectPageSummary[] | null> {
  await ensureBrainStoreReady();
  const db = getQueryableDb();
  if (!db) return null;

  // `listPages()` hydrates full compiled page content, which is too expensive
  // for project tree/list endpoints that only need titles and frontmatter.
  const { rows } = await db.query(
    `SELECT p.slug, p.type, p.title, p.frontmatter
     FROM pages p
     WHERE ${projectMatchSql("p")}
     ORDER BY p.updated_at DESC
     LIMIT $2`,
    [project, PAGE_SUMMARY_LIMIT],
  );

  return rows.map((row) => ({
    path: typeof row.slug === "string" ? row.slug : "",
    type: typeof row.type === "string" ? row.type : "concept",
    title: typeof row.title === "string" ? row.title : "",
    frontmatter: parseFrontmatter(row.frontmatter),
  }));
}

export async function listProjectWorkspaceFileEntriesFast(
  project: string,
): Promise<ProjectWorkspaceFileEntry[] | null> {
  await ensureBrainStoreReady();
  const db = getQueryableDb();
  if (!db || unsupportedWorkspaceFilesTables.has(db)) return null;

  // The workspace tree only needs file metadata plus the owning page slug; keep
  // the heavy page body fetch deferred until a specific companion page is opened.
  let rows: QueryResultRow[];
  try {
    ({ rows } = await db.query(
      `SELECT
         p.slug AS page_slug,
         p.type AS page_type,
         p.title AS page_title,
         p.frontmatter AS page_frontmatter,
         p.updated_at AS updated_at,
         f.filename AS filename,
         f.mime_type AS mime_type,
         f.size_bytes AS size_bytes,
         f.content_hash AS content_hash
       FROM files f
       JOIN pages p ON p.slug = f.page_slug
       WHERE ${projectMatchSql("p")}
       ORDER BY p.updated_at DESC, p.slug ASC, f.filename ASC
       LIMIT $2`,
      [project, WORKSPACE_FILE_LIMIT],
    ));
  } catch (error) {
    if (isMissingRelationError(error, "files")) {
      unsupportedWorkspaceFilesTables.add(db);
      return null;
    }
    throw error;
  }

  const entries: ProjectWorkspaceFileEntry[] = [];
  for (const row of rows) {
    const sha256 = typeof row.content_hash === "string" ? row.content_hash : "";
    const filename = typeof row.filename === "string" ? row.filename : "";
    if (!isSha256Hex(sha256) || filename.length === 0) continue;

    const sizeValue =
      typeof row.size_bytes === "number"
        ? row.size_bytes
        : typeof row.size_bytes === "string"
          ? Number.parseInt(row.size_bytes, 10)
          : Number.NaN;
    if (!Number.isFinite(sizeValue) || sizeValue < 0) continue;

    entries.push({
      workspacePath: filename,
      pagePath: typeof row.page_slug === "string" ? row.page_slug : "",
      pageType: typeof row.page_type === "string" ? row.page_type : "concept",
      pageTitle: typeof row.page_title === "string" ? row.page_title : "",
      pageFrontmatter: parseFrontmatter(row.page_frontmatter),
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
      ref: {
        role: "source",
        fileObjectId: `sha256:${sha256.toLowerCase()}`,
        sha256: sha256.toLowerCase(),
        filename,
        mime:
          typeof row.mime_type === "string" && row.mime_type.trim().length > 0
            ? row.mime_type
            : "application/octet-stream",
        sizeBytes: sizeValue,
      },
    });
  }

  return entries;
}
