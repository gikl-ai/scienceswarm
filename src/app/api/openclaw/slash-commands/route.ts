import { listOpenClawSkills } from "@/lib/openclaw/skill-catalog";
import { buildOpenClawSlashCommands } from "@/lib/openclaw/slash-commands";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const skills = await listOpenClawSkills();
    const commands = buildOpenClawSlashCommands(skills);
    return Response.json({ commands });
  } catch {
    return Response.json(
      { error: "Failed to load OpenClaw slash commands." },
      { status: 500 },
    );
  }
}
