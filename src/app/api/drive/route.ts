import {
  getAuthUrl,
  handleCallback,
  GoogleDriveOAuthStateError,
  isConnected,
  disconnect,
  listFiles,
  listFolders,
  searchFiles,
  downloadFile,
} from "@/lib/google-drive";
import { isLocalRequest } from "@/lib/local-guard";

// ── GET handler ───────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");

  if (action !== "callback" && !(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    switch (action) {
      case "auth-url": {
        const { url } = getAuthUrl();
        return Response.json({ url });
      }
      case "callback": {
        const code = searchParams.get("code");
        const state = searchParams.get("state");
        if (!code) return Response.json({ error: "Missing code parameter" }, { status: 400 });
        if (!state) {
          return Response.json({ error: "Missing state parameter" }, { status: 400 });
        }
        const result = await handleCallback(code, state);
        // Redirect back to the dashboard after successful OAuth
        if (result.success) {
          return new Response(null, {
            status: 302,
            headers: { Location: "/dashboard/project?drive=connected" },
          });
        }
        return Response.json({ error: "OAuth callback failed" }, { status: 500 });
      }
      case "status": {
        return Response.json({ connected: isConnected() });
      }
      case "list": {
        const folderId = searchParams.get("folderId") || undefined;
        const files = await listFiles(folderId);
        return Response.json({ files });
      }
      case "folders": {
        const parentId = searchParams.get("parentId") || undefined;
        const folders = await listFolders(parentId);
        return Response.json({ folders });
      }
      case "search": {
        const query = searchParams.get("q");
        if (!query) return Response.json({ error: "Missing q parameter" }, { status: 400 });
        const files = await searchFiles(query);
        return Response.json({ files });
      }
      case "download": {
        const fileId = searchParams.get("fileId");
        if (!fileId) return Response.json({ error: "Missing fileId parameter" }, { status: 400 });
        const result = await downloadFile(fileId);
        return Response.json(result);
      }
      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof GoogleDriveOAuthStateError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const raw = await request.json().catch(() => null);
    if (!raw || typeof raw !== "object") {
      return Response.json({ error: "Invalid or missing JSON body" }, { status: 400 });
    }
    const body = raw as Record<string, unknown>;
    const action = body.action as string | undefined;
    if (!action || typeof action !== "string") {
      return Response.json({ error: "Missing action field" }, { status: 400 });
    }

    switch (action) {
      case "import": {
        const fileId = body.fileId as string;
        if (!fileId) return Response.json({ error: "Missing fileId" }, { status: 400 });
        const result = await downloadFile(fileId);
        return Response.json({
          success: true,
          file: { name: result.name, content: result.content, mimeType: result.mimeType },
        });
      }
      case "batch-import": {
        const fileIds = body.fileIds as string[];
        if (!Array.isArray(fileIds) || fileIds.length === 0) {
          return Response.json({ error: "fileIds must be a non-empty array" }, { status: 400 });
        }
        const results = [];
        const errors = [];
        for (const fileId of fileIds) {
          try {
            const result = await downloadFile(fileId);
            results.push({ name: result.name, content: result.content, mimeType: result.mimeType });
          } catch (err) {
            errors.push({ fileId, error: err instanceof Error ? err.message : "Download failed" });
          }
        }
        return Response.json({ success: true, files: results, errors });
      }
      case "sync": {
        const folderId = body.folderId as string;
        if (!folderId) return Response.json({ error: "Missing folderId" }, { status: 400 });
        const files = await listFiles(folderId);
        // Download all non-folder files
        const results = [];
        const errors = [];
        for (const file of files) {
          if (file.mimeType === "application/vnd.google-apps.folder") continue;
          try {
            const result = await downloadFile(file.id);
            results.push({ name: result.name, content: result.content, mimeType: result.mimeType });
          } catch (err) {
            errors.push({ fileId: file.id, name: file.name, error: err instanceof Error ? err.message : "Download failed" });
          }
        }
        return Response.json({ success: true, files: results, errors, totalInFolder: files.length });
      }
      case "disconnect": {
        disconnect();
        return Response.json({ success: true });
      }
      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
