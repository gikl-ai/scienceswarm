import type { OpenClawSlashCommandSkill } from "@/lib/openclaw/slash-commands";
import { listOpenClawSkills } from "@/lib/openclaw/skill-catalog";
import { listInstalledMarketPlugins } from "@/lib/plugins/market";

export async function listScienceSwarmOpenClawSlashCommandSkills(): Promise<OpenClawSlashCommandSkill[]> {
  const [repoSkills, marketPlugins] = await Promise.all([
    listOpenClawSkills(),
    listInstalledMarketPlugins(),
  ]);

  const merged = new Map<string, OpenClawSlashCommandSkill>();

  for (const skill of repoSkills) {
    merged.set(skill.slug, {
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      runtime: skill.runtime,
      emoji: skill.emoji,
      aliases: readStringArray(skill.frontmatter.aliases),
    });
  }

  for (const plugin of marketPlugins) {
    if (plugin.hosts.openclaw.status !== "installed") {
      continue;
    }
    for (const skill of plugin.skills) {
      if (merged.has(skill.slug)) {
        continue;
      }
      merged.set(skill.slug, {
        slug: skill.slug,
        name: skill.slug,
        description: skill.description,
        runtime: skill.runtime,
        emoji: skill.emoji,
      });
    }
  }

  return [...merged.values()].sort((left, right) => left.slug.localeCompare(right.slug));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string =>
    typeof entry === "string" && entry.trim().length > 0
  );
}
