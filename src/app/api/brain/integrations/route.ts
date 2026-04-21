/**
 * GET /api/brain/integrations — Returns integration status for all providers
 * POST /api/brain/integrations — Trigger sync or update config
 *
 * Uses Response.json() per API route rules.
 */

import { getIntegrationStatus, syncAll } from "@/lib/integrations";
import { getBrainConfig, isErrorResponse } from "../_shared";

export async function GET() {
  try {
    const status = await getIntegrationStatus();
    return Response.json({ integrations: status });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to check integration status";
    return Response.json({ error: message }, { status: 500 });
  }
}

interface PostBody {
  provider: string;
  action: "sync" | "configure";
  config?: Record<string, string>;
}

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body.provider || !body.action) {
    return Response.json(
      { error: "Missing required fields: provider, action" },
      { status: 400 },
    );
  }

  const validProviders = ["google-calendar", "gmail", "zotero"];
  if (!validProviders.includes(body.provider)) {
    return Response.json(
      { error: `Invalid provider: ${body.provider}. Must be one of: ${validProviders.join(", ")}` },
      { status: 400 },
    );
  }

  if (body.action !== "sync" && body.action !== "configure") {
    return Response.json(
      { error: `Invalid action: ${body.action}. Must be "sync" or "configure"` },
      { status: 400 },
    );
  }

  if (body.action === "sync") {
    const configOrError = getBrainConfig();
    if (isErrorResponse(configOrError)) return configOrError;
    const config = configOrError;

    try {
      const report = await syncAll(config);
      const providerResult = report.results.find(
        (r) => r.provider === body.provider,
      );

      if (!providerResult) {
        return Response.json(
          { error: `Provider ${body.provider} is not configured. Set the required environment variables.` },
          { status: 422 },
        );
      }

      return Response.json({ sync: providerResult });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Sync failed";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  // action === "configure"
  return Response.json({
    message: `Configuration for ${body.provider} acknowledged. Set environment variables to enable the integration.`,
    provider: body.provider,
  });
}
