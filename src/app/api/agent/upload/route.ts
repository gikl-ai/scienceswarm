import { uploadFiles } from "@/lib/openhands";
import { isLocalRequest } from "@/lib/local-guard";

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const formData = await request.formData();
    const conversationId = formData.get("conversationId") as string;

    if (!conversationId) {
      return Response.json({ error: "conversationId required" }, { status: 400 });
    }

    // Forward the files to OpenHands
    const agentFormData = new FormData();
    const files = formData.getAll("files");
    for (const file of files) {
      agentFormData.append("files", file);
    }

    const result = await uploadFiles(conversationId, agentFormData);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload error";
    return Response.json({ error: message }, { status: 500 });
  }
}
