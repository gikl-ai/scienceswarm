import { ZodError } from "zod";
import { paperLibraryError } from "@/lib/paper-library/contracts";
import { isLocalRequest } from "@/lib/local-guard";
import { getBrainConfig, isErrorResponse } from "../_shared";

export async function requirePaperLibraryRequest(request: Request): Promise<
  | { ok: true; brainRoot: string }
  | { ok: false; response: Response }
> {
  if (!(await isLocalRequest(request))) {
    return {
      ok: false,
      response: Response.json(paperLibraryError("unsafe_path", "Forbidden."), { status: 403 }),
    };
  }

  const configOrError = getBrainConfig();
  if (isErrorResponse(configOrError)) return { ok: false, response: configOrError };
  return { ok: true, brainRoot: configOrError.root };
}

export function paperLibraryBadRequest(error: unknown): Response {
  if (error instanceof ZodError) {
    return Response.json(
      paperLibraryError("invalid_state", "Invalid paper-library request.", error.issues),
      { status: 400 },
    );
  }
  const message = error instanceof Error ? error.message : "Invalid paper-library request.";
  if (message === "invalid_cursor") {
    return Response.json(paperLibraryError("invalid_cursor", "Invalid pagination cursor."), { status: 400 });
  }
  return Response.json(paperLibraryError("invalid_state", message), { status: 400 });
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body.");
  }
}
