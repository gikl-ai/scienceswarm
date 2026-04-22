import { isLocalRequest } from "@/lib/local-guard";
import {
  installMarketPluginFromGitHub,
  listInstalledMarketPlugins,
  MarketPluginConflictError,
  MarketPluginValidationError,
} from "@/lib/plugins/market";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const plugins = await listInstalledMarketPlugins();
    return Response.json({ plugins });
  } catch {
    return Response.json({ error: "Failed to load installed market plugins." }, { status: 500 });
  }
}

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
    const plugin = await installMarketPluginFromGitHub({
      repo,
      path: importPath,
      ref:
        payload && typeof payload === "object" && "ref" in payload && typeof payload.ref === "string"
          ? payload.ref
          : "main",
    });

    return Response.json(
      {
        plugin,
        message:
          "Installed privately into local OpenClaw, Codex, and Claude Code surfaces. Restart the OpenClaw gateway if it was already running.",
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof MarketPluginValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof MarketPluginConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: "Failed to install market plugin." }, { status: 500 });
  }
}
