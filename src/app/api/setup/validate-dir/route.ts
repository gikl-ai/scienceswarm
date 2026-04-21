/**
 * POST /api/setup/validate-dir
 *
 * Performs the same server-side `SCIENCESWARM_DIR` validation the save
 * route uses, but without mutating `.env`. The `/setup` page
 * calls this as the user types so it can show the resolved absolute
 * path, flag unwritable locations before save, and keep the primary
 * action disabled until the required path is valid.
 */

import { isLocalRequest } from "@/lib/local-guard";
import { resolveConfiguredPath } from "@/lib/scienceswarm-paths";
import {
  validateScienceSwarmDir,
  type FieldStatus,
} from "@/lib/setup/config-status";

interface ValidateDirRequestBody {
  value?: unknown;
}

interface ValidateDirResponse {
  status: FieldStatus;
  resolvedPath: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid JSON in request body" },
      { status: 400 },
    );
  }

  if (!isPlainObject(raw)) {
    return Response.json(
      { error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const { value } = raw as ValidateDirRequestBody;
  if (typeof value !== "string") {
    return Response.json(
      { error: "Field 'value' must be a string" },
      { status: 400 },
    );
  }

  const trimmed = value.trim();
  const response: ValidateDirResponse = {
    status: await validateScienceSwarmDir(trimmed),
    resolvedPath:
      trimmed.length === 0 ? null : resolveConfiguredPath(trimmed),
  };
  return Response.json(response);
}
