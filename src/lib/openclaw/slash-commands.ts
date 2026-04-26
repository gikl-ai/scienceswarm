export interface OpenClawSlashCommandSkill {
  slug: string;
  name: string;
  description: string;
  runtime: string | null;
  emoji: string | null;
  aliases?: string[];
}

export type OpenClawSlashCommandKind = "builtin" | "skill";

export interface OpenClawSlashCommandRecord {
  kind: OpenClawSlashCommandKind;
  command: string;
  description: string;
  argumentHint: string | null;
  emoji: string | null;
  skillSlug: string | null;
}

export interface ParsedOpenClawSlashCommand {
  command: OpenClawSlashCommandRecord;
  arguments: string;
  raw: string;
}

export interface BuildOpenClawSlashCommandPromptOptions {
  hostId?: string | null;
  skillInstructions?: string | null;
}

const LEADING_SLASH_COMMAND_PATTERN =
  /^\s*\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;

function helpCommand(): OpenClawSlashCommandRecord {
  return {
    kind: "builtin",
    command: "help",
    description:
      "Show available ScienceSwarm slash commands and installed skill shortcuts.",
    argumentHint: null,
    emoji: "\u2753",
    skillSlug: null,
  };
}

function isChatInvokableSkill(skill: OpenClawSlashCommandSkill): boolean {
  return skill.runtime !== "separate-node-process";
}

function preferredCommandName(skill: OpenClawSlashCommandSkill): string {
  if (skill.slug.startsWith("db-")) {
    return skill.slug.slice("db-".length);
  }
  if (skill.slug.startsWith("scienceswarm-")) {
    return skill.slug.slice("scienceswarm-".length);
  }
  return skill.slug;
}

function isValidSlashCommandName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

function skillArgumentHint(skill: OpenClawSlashCommandSkill): string {
  return skill.slug.startsWith("db-") ? "[query or identifier]" : "[request]";
}

export function looksLikeSlashCommandInput(value: string): boolean {
  return /^\s*\/[a-z0-9]/i.test(value);
}

export function buildOpenClawSlashCommands(
  skills: OpenClawSlashCommandSkill[],
): OpenClawSlashCommandRecord[] {
  const commands: OpenClawSlashCommandRecord[] = [helpCommand()];
  const taken = new Set(commands.map((command) => command.command));

  for (const skill of skills) {
    if (!isChatInvokableSkill(skill)) {
      continue;
    }

    const commandCandidates = [
      ...(skill.aliases ?? []),
      preferredCommandName(skill),
      skill.slug,
    ];

    for (const candidate of commandCandidates) {
      const commandName = candidate.toLowerCase();
      if (!isValidSlashCommandName(commandName) || taken.has(commandName)) {
        continue;
      }

      commands.push({
        kind: "skill",
        command: commandName,
        description: skill.description,
        argumentHint: skillArgumentHint(skill),
        emoji: skill.emoji,
        skillSlug: skill.slug,
      });
      taken.add(commandName);
      break;
    }
  }

  return commands;
}

export function parseOpenClawSlashCommandInput(
  value: string,
  commands: OpenClawSlashCommandRecord[],
): ParsedOpenClawSlashCommand | null {
  const trimmed = value.trim();
  const match = LEADING_SLASH_COMMAND_PATTERN.exec(trimmed);
  if (!match) {
    return null;
  }

  const commandName = match[1]?.toLowerCase();
  const command = commands.find(
    (candidate) => candidate.command === commandName,
  );
  if (!command) {
    return null;
  }

  return {
    command,
    arguments: (match[2] ?? "").trim(),
    raw: trimmed,
  };
}

export function buildOpenClawSlashCommandPrompt(
  parsed: ParsedOpenClawSlashCommand,
  options: BuildOpenClawSlashCommandPromptOptions = {},
): string {
  if (parsed.command.kind === "builtin") {
    return `The user asked for ScienceSwarm slash-command help via \`${parsed.raw}\`.`;
  }

  const segments = [
    `ScienceSwarm slash command: \`${parsed.raw}\``,
    `Skill description: ${parsed.command.description}`,
    [
      "Scope rule: the current user request is authoritative.",
      "Do not substitute a different molecule, project, prior study, or previous MD asset unless the user explicitly names it in this request.",
      "Use prior project artifacts only when they match the requested system and question.",
    ].join(" "),
  ];

  if (options.skillInstructions?.trim()) {
    const hostLabel = options.hostId ? ` for ${options.hostId}` : "";
    segments.push(
      [
        `Embedded ScienceSwarm skill instructions${hostLabel}:`,
        "Follow these instructions directly. Do not call or require a separate skill loader for this slug.",
        "```markdown",
        options.skillInstructions.trim(),
        "```",
      ].join("\n"),
    );
  } else {
    segments.push(
      `Use the installed ScienceSwarm skill \`${parsed.command.skillSlug}\` as the primary procedure for this request.`,
    );
  }

  if (parsed.arguments.length > 0) {
    segments.push(`User request:\n${parsed.arguments}`);
  } else {
    segments.push(
      "No additional arguments were provided. Use the skill's default behavior for the current conversation and ask one concise clarifying question only if the next step is ambiguous.",
    );
  }

  return segments.join("\n\n");
}

export function expandOpenClawSlashCommandInput(
  value: string,
  commands: OpenClawSlashCommandRecord[],
): string {
  const parsed = parseOpenClawSlashCommandInput(value, commands);
  if (!parsed) {
    return value;
  }

  return buildOpenClawSlashCommandPrompt(parsed);
}

function formatSlashCommandLine(command: OpenClawSlashCommandRecord): string {
  const suffix = command.argumentHint ? ` ${command.argumentHint}` : "";
  return `- \`/${command.command}${suffix}\` — ${command.description}`;
}

export function renderOpenClawSlashHelp(
  commands: OpenClawSlashCommandRecord[],
): string {
  const builtIns = commands.filter((command) => command.kind === "builtin");
  const skills = commands.filter((command) => command.kind === "skill");

  return [
    "**ScienceSwarm slash commands**",
    "",
    "Use `/<command> [arguments]` in the project chat composer.",
    "",
    "**Built-in**",
    ...builtIns.map(formatSlashCommandLine),
    "",
    "**Installed skills**",
    ...(skills.length > 0
      ? skills.map(formatSlashCommandLine)
      : [
          "- No repo-backed in-session OpenClaw skills are currently installed.",
        ]),
  ].join("\n");
}
