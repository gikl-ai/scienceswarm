import { handleUnifiedChatPost } from "@/app/api/chat/unified/route";
import { isLocalRequest } from "@/lib/local-guard";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!(await isLocalRequest(request))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return handleUnifiedChatPost(request, { commandTransport: true });
}
