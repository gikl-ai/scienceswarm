import { isLocalRequest } from "@/lib/local-guard";
import {
  MarketPluginNotFoundError,
  MarketPluginValidationError,
  reinstallMarketPlugin,
  uninstallMarketPlugin,
  updateMarketPluginFromGitHub,
} from "@/lib/plugins/market";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    plugin: string;
  }>;
};

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { plugin } = await context.params;

  try {
    await uninstallMarketPlugin(plugin);
    return Response.json({
      message: "Removed the local market plugin install from OpenClaw, Codex, Claude Code, and cleared its ScienceSwarm metadata.",
    });
  } catch (error) {
    if (error instanceof MarketPluginValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof MarketPluginNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json({ error: "Failed to uninstall market plugin." }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { plugin } = await context.params;
  const payload = await request.json().catch(() => ({}));
  const action =
    payload && typeof payload === "object" && "action" in payload && payload.action === "update"
      ? "update"
      : "reinstall";

  try {
    const updated =
      action === "update"
        ? await updateMarketPluginFromGitHub(plugin)
        : await reinstallMarketPlugin(plugin);

    return Response.json({
      plugin: updated,
      message:
        action === "update"
          ? "Updated the private market install from upstream and refreshed OpenClaw, Codex, and Claude Code projections."
          : "Reinstalled the private market plugin into OpenClaw, Codex, and Claude Code from the pinned local bundle snapshot.",
    });
  } catch (error) {
    if (error instanceof MarketPluginValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof MarketPluginNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return Response.json({ error: "Failed to refresh market plugin." }, { status: 500 });
  }
}
