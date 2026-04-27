import { isLocalRequest } from "@/lib/local-guard";
import { getOrCreateLocalInstallId } from "@/lib/local-install-id";

export async function GET() {
  if (!(await isLocalRequest())) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const localInstallId = await getOrCreateLocalInstallId();
  return Response.json({ localInstallId });
}
