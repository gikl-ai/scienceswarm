import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  output: process.env.CAPACITOR_BUILD ? "export" : undefined,
  // TODO: API routes (/api/agent, /api/chat, /api/parse-file) must be
  // moved to a separate backend before static export can be enabled.
  transpilePackages: ["gbrain"],
  // pdf-parse@2 ships a single "." entry whose conditions resolve to a
  // browser-first CJS build that references DOMMatrix. When Turbopack
  // bundles it into the server graph we hit `DOMMatrix is not defined`
  // at runtime even though plain `node -e` works. Marking it external
  // lets Node's real resolver pick the correct condition.
  //
  // PGLite must also stay external on the server. Its pgvector/pg_trgm
  // extensions resolve adjacent `.tar.gz` files via `import.meta.url`;
  // when Turbopack bundles it, those become `/_next/static/media/...`
  // asset URLs and gbrain init fails before PG_VERSION is written.
  serverExternalPackages: ["pdf-parse", "@electric-sql/pglite"],
  turbopack: {
    root: PROJECT_ROOT,
  },
};

export default nextConfig;
