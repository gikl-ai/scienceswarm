import { isLocalRequest } from "@/lib/local-guard";
import {
  inspectMarketPluginFromGitHub,
  MarketPluginValidationError,
} from "@/lib/plugins/market";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const payload = await request.json().catch(() => ({}));
  const repo =
    payload && typeof payload === "object" && "repo" in payload && typeof payload.repo === "string"
      ? payload.repo
      : null;
  const importPath =
    payload && typeof payload === "object" && "path" in payload && typeof payload.path === "string"
      ? payload.path
      : null;

  if (!repo || !importPath) {
    return Response.json(
      { error: "Request body must include repo and path." },
      { status: 400 },
    );
  }

  try {
    const preview = await inspectMarketPluginFromGitHub({
      repo,
      path: importPath,
      ref:
        payload && typeof payload === "object" && "ref" in payload && typeof payload.ref === "string"
          ? payload.ref
          : "main",
    });
    return Response.json({ preview });
  } catch (error) {
    if (error instanceof MarketPluginValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return Response.json({ error: "Failed to inspect market plugin." }, { status: 500 });
  }
}
