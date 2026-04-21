import { handleUnifiedChatPost } from "@/app/api/chat/unified/route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleUnifiedChatPost(request, { commandTransport: true });
}
