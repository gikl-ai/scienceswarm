import { GET as workspaceRouteGet } from "../../../route";

type WorkspaceRawRouteContext = {
  params: Promise<{
    projectId: string;
    file: string[];
  }>;
};

export async function GET(request: Request, context: WorkspaceRawRouteContext) {
  const params = await context.params;
  const projectId = params.projectId?.trim();
  const fileSegments = Array.isArray(params.file) ? params.file : [];
  if (!projectId) {
    return new Response("projectId parameter required", { status: 400 });
  }
  if (fileSegments.length === 0) {
    return new Response("file parameter required", { status: 400 });
  }
  if (fileSegments.some((segment) => segment === "." || segment === "..")) {
    return new Response("Invalid file path", { status: 400 });
  }

  const forwardedUrl = new URL(request.url);
  forwardedUrl.pathname = "/api/workspace";
  forwardedUrl.search = "";
  forwardedUrl.searchParams.set("action", "raw");
  forwardedUrl.searchParams.set("projectId", projectId);
  forwardedUrl.searchParams.set("file", fileSegments.join("/"));

  return workspaceRouteGet(new Request(forwardedUrl, request));
}
