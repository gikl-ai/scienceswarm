import { listOpenClawSkills } from "@/lib/openclaw/skill-catalog";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const skills = await listOpenClawSkills();
    return Response.json({ skills });
  } catch {
    return Response.json({ error: "Failed to load OpenClaw skills." }, { status: 500 });
  }
}
