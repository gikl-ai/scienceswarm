/**
 * POST /api/setup/install-brain
 *
 * Streams the gbrain installer's progress events to the browser as
 * Server-Sent Events. The /setup page renders a step-by-step progress
 * UI from this stream.
 *
 * Phase A Lane 1 of the ScienceSwarm -> gbrain pivot.
 *
 * Contract notes
 *   * Per .claude/rules/api-routes.md, this route returns
 *     `Response.json()` / `new Response()` and never `NextResponse`.
 *   * The body is optional. Recognised fields:
 *       - `brainRoot?: string`  override the default brain dir
 *       - `skipNetworkCheck?: boolean`  bypass the bun.sh probe (useful
 *         when the dev machine is offline by design)
 *   * Any error before the stream starts is surfaced as a normal
 *     `Response.json({error}, {status: 4xx|5xx})`. Once the stream is
 *     open, errors are emitted as `event: step` SSE entries with
 *     `status: "failed"` and a closing `event: summary` entry. We
 *     never throw inside the stream's pull callback.
 *
 * On the wire, every SSE event has shape:
 *
 *   event: <step | summary>
 *   data: <JSON serialization of the InstallerEvent>
 *
 * The `event:` line lets EventSource clients filter by type if they
 * want; the JSON `data` line is the canonical payload.
 */

import { type BrainPresetId, isBrainPresetId } from "@/brain/presets/types";
import type { InstallerEvent } from "@/lib/setup/gbrain-installer";
import { isLocalRequest } from "@/lib/local-guard";

interface RequestBody {
  brainRoot?: string;
  brainPreset?: BrainPresetId;
  skipNetworkCheck?: boolean;
}

type InstallerModule = typeof import("@/lib/setup/gbrain-installer");

async function loadInstallerModule(): Promise<InstallerModule> {
  return await import("@/lib/setup/gbrain-installer");
}

function parseBody(raw: unknown): RequestBody | { error: string } {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Request body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const result: RequestBody = {};
  if ("brainRoot" in obj) {
    if (typeof obj.brainRoot !== "string") {
      return { error: "brainRoot must be a string" };
    }
    if (obj.brainRoot.trim().length === 0) {
      return { error: "brainRoot must be non-empty" };
    }
    result.brainRoot = obj.brainRoot;
  }
  if ("brainPreset" in obj) {
    if (!isBrainPresetId(obj.brainPreset)) {
      return { error: "brainPreset must be a valid ScienceSwarm brain preset" };
    }
    result.brainPreset = obj.brainPreset;
  }
  if ("skipNetworkCheck" in obj) {
    if (typeof obj.skipNetworkCheck !== "boolean") {
      return { error: "skipNetworkCheck must be a boolean" };
    }
    result.skipNetworkCheck = obj.skipNetworkCheck;
  }
  return result;
}

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // 1. Parse the body. Empty body is allowed — defaults kick in.
  //
  // The header dance is subtle: clients can send a body without a
  // `Content-Length` header (HTTP/2 chunked, plain `curl -X POST -d`,
  // streaming uploads), so we cannot decide "skip parsing" purely from
  // the absence of that header. Equally we cannot blindly call
  // `request.json()`, because a bodyless POST with no `Content-Length`
  // throws a parse error and 400s the contract.
  //
  // The robust shape is: read the body as text, then parse it as JSON
  // only when there is actually something to parse. An explicit
  // `Content-Length: 0` short-circuits the read entirely. Greptile
  // pointed out both halves of this in PR #242.
  let raw: unknown = null;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== "0") {
    try {
      const text = await request.text();
      if (text.trim().length > 0) {
        raw = JSON.parse(text);
      }
    } catch {
      return Response.json(
        { error: "Invalid JSON in request body" },
        { status: 400 },
      );
    }
  }
  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  // 2. Lazy-load the heavy installer runtime and build its production
  //    environment up front so any setup error still surfaces as a
  //    normal JSON 500 (not a half-opened stream).
  let installer: InstallerModule;
  let env: Awaited<ReturnType<InstallerModule["defaultInstallerEnvironment"]>>;
  try {
    installer = await loadInstallerModule();
    env = await installer.defaultInstallerEnvironment();
  } catch (err) {
    console.error("api/setup/install-brain: failed to construct environment", err);
    return Response.json(
      { error: "Installer is not available in this environment" },
      { status: 500 },
    );
  }

  // 3. Stream events as SSE. We use a TransformStream so the
  //    generator can run concurrently with the HTTP response — each
  //    yield writes one SSE block, the connection stays open until
  //    the summary lands.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of installer.runInstaller(
          {
            repoRoot: process.cwd(),
            brainRoot: parsed.brainRoot,
            brainPreset: parsed.brainPreset,
            skipNetworkCheck: parsed.skipNetworkCheck,
          },
          env,
        )) {
          controller.enqueue(encoder.encode(formatSseEvent(event)));
        }
      } catch (err) {
        // The generator should never throw — every failure path
        // yields a `summary` event. If we end up here something is
        // wrong with the installer wiring itself; emit a synthetic
        // failed-summary so the UI still terminates cleanly.
        console.error("api/setup/install-brain: installer threw", err);
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(
            formatSseEvent({
              type: "summary",
              status: "failed",
              error: {
                code: "internal",
                message: "Installer crashed unexpectedly.",
                recovery:
                  "Check the ScienceSwarm server logs and re-run install.",
                cause: message,
              },
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // Disable proxy buffering so events show up in real time. nginx
      // and Vercel both honour this header; harmless on plain Next.
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function formatSseEvent(event: InstallerEvent): string {
  // SSE syntax: an `event:` field, then a `data:` field, then a blank
  // line. We pick the SSE event name from the discriminant so clients
  // can use `addEventListener("step", …)` if they want fine-grained
  // routing instead of one big "message" handler.
  const name = event.type === "summary" ? "summary" : "step";
  return `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
}
