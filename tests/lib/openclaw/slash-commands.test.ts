import { describe, expect, it } from "vitest";
import {
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
        slug: "project-organizer",
        name: "project-organizer",
        description: "Organize the current project",
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
      "project-organizer",
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
    expect(expanded).toContain("User request:\nTP53 mutation");
  });

  it("renders a help response that lists the available commands", () => {
    const commands = buildOpenClawSlashCommands([
      {
        slug: "project-organizer",
        name: "project-organizer",
        description: "Organize the current project",
        runtime: "in-session",
        emoji: null,
      },
    ]);

    const help = renderOpenClawSlashHelp(commands);
    expect(help).toContain("**ScienceSwarm slash commands**");
    expect(help).toContain("`/help`");
    expect(help).toContain("`/project-organizer [request]`");
  });
});
