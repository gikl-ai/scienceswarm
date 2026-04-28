import { describe, expect, it } from "vitest";
import {
  buildOpenClawSlashCommandPrompt,
  buildOpenClawSlashCommands,
  expandOpenClawSlashCommandInput,
  parseOpenClawSlashCommandInput,
  renderOpenClawSlashHelp,
} from "@/lib/openclaw/slash-commands";

describe("openclaw slash commands", () => {
  it("builds help plus chat-invokable skill commands from installed skills", () => {
    const commands = buildOpenClawSlashCommands([
      {
        slug: "scienceswarm-capture",
        name: "scienceswarm-capture",
        description: "Capture research notes into the brain",
        runtime: null,
        emoji: "CC",
      },
      {
        slug: "study-organizer",
        name: "study-organizer",
        description: "Organize the current study",
        runtime: "in-session",
        emoji: null,
      },
      {
        slug: "db-pubmed",
        name: "db-pubmed",
        description: "Search PubMed",
        runtime: "in-session",
        emoji: "PM",
      },
      {
        slug: "research-radar",
        name: "research-radar",
        description: "Runs on a schedule",
        runtime: "separate-node-process",
        emoji: null,
      },
    ]);

    expect(commands.map((command) => command.command)).toEqual([
      "help",
      "capture",
      "study-organizer",
      "pubmed",
    ]);
    expect(
      commands.find((command) => command.command === "pubmed"),
    ).toMatchObject({
      kind: "skill",
      skillSlug: "db-pubmed",
      argumentHint: "[query or identifier]",
    });
  });

  it("falls back to the full skill slug when a derived command would collide", () => {
    const commands = buildOpenClawSlashCommands([
      {
        slug: "foo",
        name: "foo",
        description: "Primary foo",
        runtime: "in-session",
        emoji: null,
      },
      {
        slug: "scienceswarm-foo",
        name: "scienceswarm-foo",
        description: "Scoped foo",
        runtime: "in-session",
        emoji: null,
      },
    ]);

    expect(commands.map((command) => command.command)).toEqual([
      "help",
      "foo",
      "scienceswarm-foo",
    ]);
  });

  it("parses and expands skill slash commands into a durable prompt", () => {
    const commands = buildOpenClawSlashCommands([
      {
        slug: "db-pubmed",
        name: "db-pubmed",
        description: "Search PubMed",
        runtime: "in-session",
        emoji: "PM",
      },
    ]);

    expect(
      parseOpenClawSlashCommandInput("/pubmed TP53 mutation", commands),
    ).toMatchObject({
      arguments: "TP53 mutation",
      command: expect.objectContaining({
        command: "pubmed",
        skillSlug: "db-pubmed",
      }),
    });

    const expanded = expandOpenClawSlashCommandInput(
      "/pubmed TP53 mutation",
      commands,
    );
    expect(expanded).toContain(
      "ScienceSwarm slash command: `/pubmed TP53 mutation`",
    );
    expect(expanded).toContain(
      "Use the installed ScienceSwarm skill `db-pubmed`",
    );
    expect(expanded).toContain(
      "Do not substitute a different molecule, project, prior study, or previous MD asset",
    );
    expect(expanded).toContain("User request:\nTP53 mutation");
  });

  it("can embed host skill instructions for runtimes without a skill loader", () => {
    const commands = buildOpenClawSlashCommands([
      {
        slug: "scienceswarm-md-study-design",
        name: "scienceswarm-md-study-design",
        description: "Create an MD Study Brief",
        runtime: "in-session",
        emoji: null,
        aliases: ["md-study"],
      },
    ]);
    const parsed = parseOpenClawSlashCommandInput(
      "/md-study lysozyme stability",
      commands,
    );
    expect(parsed).not.toBeNull();

    const expanded = parsed
      ? expandOpenClawSlashCommandInput("/md-study lysozyme stability", commands)
      : "";
    expect(expanded).toContain(
      "Use the installed ScienceSwarm skill `scienceswarm-md-study-design`",
    );

    const embedded = parsed
      ? buildOpenClawSlashCommandPrompt(parsed, {
          hostId: "claude-code",
          skillInstructions: "# ScienceSwarm MD Study Design\n\nProduce an MD Study Brief.",
        })
      : "";
    expect(embedded).toContain(
      "Embedded ScienceSwarm skill instructions for claude-code:",
    );
    expect(embedded).toContain(
      "Do not call or require a separate skill loader",
    );
    expect(embedded).toContain("Produce an MD Study Brief.");
    expect(embedded).not.toContain(
      "Use the installed ScienceSwarm skill `scienceswarm-md-study-design`",
    );
  });

  it("parses multi-line slash command requests pasted from walkthroughs", () => {
    const commands = buildOpenClawSlashCommands([
      {
        slug: "scienceswarm-md-study-design",
        name: "scienceswarm-md-study-design",
        description: "Create an MD Study Brief",
        runtime: "in-session",
        emoji: null,
        aliases: ["md-study"],
      },
    ]);

    const parsed = parseOpenClawSlashCommandInput(
      `/md-study Create an MD Study Brief.

System: lysozyme.
Question: does it stay folded?`,
      commands,
    );

    expect(parsed).toMatchObject({
      arguments: "Create an MD Study Brief.\n\nSystem: lysozyme.\nQuestion: does it stay folded?",
      command: expect.objectContaining({
        command: "md-study",
        skillSlug: "scienceswarm-md-study-design",
      }),
    });
  });

  it("renders a help response that lists the available commands", () => {
    const commands = buildOpenClawSlashCommands([
      {
        slug: "study-organizer",
        name: "study-organizer",
        description: "Organize the current study",
        runtime: "in-session",
        emoji: null,
      },
    ]);

    const help = renderOpenClawSlashHelp(commands);
    expect(help).toContain("**ScienceSwarm slash commands**");
    expect(help).toContain("`/help`");
    expect(help).toContain("`/study-organizer [request]`");
  });
});
