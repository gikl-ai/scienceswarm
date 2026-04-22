/**
 * Migration script that rewrites legacy persisted `conversationBackend`
 * values to `"openclaw"`. Sibling to PR #13's hook-level migration; this
 * one rewrites the on-disk record so the runtime normaliser becomes a
 * fallback, not a load-bearing translator.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrateChatThreadsOpenClaw } from "../../scripts/migrate-chat-threads-openclaw";

interface FixtureLayout {
  dataRoot: string;
  projectsRoot: string;
}

async function makeFixture(): Promise<FixtureLayout> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "scienceswarm-migrate-chat-"));
  const projectsRoot = path.join(dataRoot, "projects");
  await mkdir(projectsRoot, { recursive: true });
  return { dataRoot, projectsRoot };
}

async function seedThread(
  projectsRoot: string,
  slug: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const dir = path.join(projectsRoot, slug, ".brain", "state");
  const chatPath = path.join(dir, "chat.json");
  await mkdir(dir, { recursive: true });
  await writeFile(chatPath, JSON.stringify(payload, null, 2), "utf-8");
  return chatPath;
}

const silentLog = () => {};
const silentWarn = () => {};

describe("migrate-chat-threads-openclaw script", () => {
  let fixture: FixtureLayout;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    await rm(fixture.dataRoot, { recursive: true, force: true });
  });

  it("rewrites legacy backend values to openclaw and leaves canonical threads alone", async () => {
    const agentPath = await seedThread(fixture.projectsRoot, "alpha-project", {
      version: 1,
      project: "alpha-project",
      conversationId: "conv-alpha",
      conversationBackend: "agent",
      messages: [{ id: "m1", role: "user", content: "hi", timestamp: "2026-04-21T10:00:00.000Z" }],
    });
    const directPath = await seedThread(fixture.projectsRoot, "beta-project", {
      version: 1,
      project: "beta-project",
      conversationId: "conv-beta",
      conversationBackend: "direct",
      messages: [],
    });
    const openclawPath = await seedThread(fixture.projectsRoot, "gamma-project", {
      version: 1,
      project: "gamma-project",
      conversationId: "conv-gamma",
      conversationBackend: "openclaw",
      messages: [],
    });

    const summary = await migrateChatThreadsOpenClaw({
      projectsRoot: fixture.projectsRoot,
      log: silentLog,
      warn: silentWarn,
    });

    expect(summary).toMatchObject({
      scanned: 3,
      migrated: 2,
      alreadyCurrent: 1,
      skipped: 0,
      errors: [],
      dryRun: false,
    });

    const agent = JSON.parse(await readFile(agentPath, "utf-8"));
    const direct = JSON.parse(await readFile(directPath, "utf-8"));
    const openclaw = JSON.parse(await readFile(openclawPath, "utf-8"));
    expect(agent.conversationBackend).toBe("openclaw");
    expect(direct.conversationBackend).toBe("openclaw");
    expect(openclaw.conversationBackend).toBe("openclaw");

    // Non-backend fields untouched.
    expect(agent.conversationId).toBe("conv-alpha");
    expect(agent.messages).toEqual([
      { id: "m1", role: "user", content: "hi", timestamp: "2026-04-21T10:00:00.000Z" },
    ]);
  });

  it("is idempotent — second run reports zero migrations", async () => {
    await seedThread(fixture.projectsRoot, "alpha-project", {
      version: 1,
      project: "alpha-project",
      conversationId: "conv-alpha",
      conversationBackend: "agent",
      messages: [],
    });

    const first = await migrateChatThreadsOpenClaw({
      projectsRoot: fixture.projectsRoot,
      log: silentLog,
      warn: silentWarn,
    });
    expect(first.migrated).toBe(1);

    const second = await migrateChatThreadsOpenClaw({
      projectsRoot: fixture.projectsRoot,
      log: silentLog,
      warn: silentWarn,
    });
    expect(second).toMatchObject({
      scanned: 1,
      migrated: 0,
      alreadyCurrent: 1,
      skipped: 0,
      errors: [],
    });
  });

  it("--dry-run reports would-migrate count without writing", async () => {
    const chatPath = await seedThread(fixture.projectsRoot, "alpha-project", {
      version: 1,
      project: "alpha-project",
      conversationId: "conv-alpha",
      conversationBackend: "direct",
      messages: [],
    });
    const before = await readFile(chatPath, "utf-8");

    const summary = await migrateChatThreadsOpenClaw({
      projectsRoot: fixture.projectsRoot,
      dryRun: true,
      log: silentLog,
      warn: silentWarn,
    });

    expect(summary).toMatchObject({
      scanned: 1,
      migrated: 1,
      alreadyCurrent: 0,
      skipped: 0,
      errors: [],
      dryRun: true,
    });
    await expect(readFile(chatPath, "utf-8")).resolves.toBe(before);
  });

  it("tolerates a missing projects root", async () => {
    const summary = await migrateChatThreadsOpenClaw({
      projectsRoot: path.join(fixture.dataRoot, "does-not-exist"),
      log: silentLog,
      warn: silentWarn,
    });
    expect(summary).toMatchObject({
      scanned: 0,
      migrated: 0,
      alreadyCurrent: 0,
      skipped: 0,
      errors: [],
    });
  });

  it("skips threads with unknown conversationBackend values without rewriting them", async () => {
    const chatPath = await seedThread(fixture.projectsRoot, "alpha-project", {
      version: 1,
      project: "alpha-project",
      conversationId: "conv-alpha",
      conversationBackend: "mystery-future-backend",
      messages: [],
    });

    const summary = await migrateChatThreadsOpenClaw({
      projectsRoot: fixture.projectsRoot,
      log: silentLog,
      warn: silentWarn,
    });
    expect(summary).toMatchObject({
      scanned: 1,
      migrated: 0,
      alreadyCurrent: 0,
      skipped: 1,
      errors: [],
    });
    const onDisk = JSON.parse(await readFile(chatPath, "utf-8"));
    expect(onDisk.conversationBackend).toBe("mystery-future-backend");
  });

  it("skips threads that pass the legacy backend gate but lack required PersistedChatThread fields", async () => {
    // Object-shaped JSON at the chat.json path with a legacy conversationBackend
    // but missing version/project/messages — the migrator must NOT rewrite it.
    const chatPath = await seedThread(fixture.projectsRoot, "alpha-project", {
      conversationBackend: "agent",
    });

    const summary = await migrateChatThreadsOpenClaw({
      projectsRoot: fixture.projectsRoot,
      log: silentLog,
      warn: silentWarn,
    });
    expect(summary).toMatchObject({
      scanned: 1,
      migrated: 0,
      alreadyCurrent: 0,
      skipped: 1,
      errors: [],
    });
    // File untouched.
    const onDisk = JSON.parse(await readFile(chatPath, "utf-8"));
    expect(onDisk.conversationBackend).toBe("agent");
    expect(onDisk.version).toBeUndefined();
  });

  it("ignores non-slug directories under the projects root", async () => {
    const chatPath = await seedThread(fixture.projectsRoot, "alpha-project", {
      version: 1,
      project: "alpha-project",
      conversationId: "conv-alpha",
      conversationBackend: "agent",
      messages: [],
    });
    // A bogus directory name that fails the slug regex — must be skipped.
    await mkdir(path.join(fixture.projectsRoot, "Not_A_Slug"), { recursive: true });

    const summary = await migrateChatThreadsOpenClaw({
      projectsRoot: fixture.projectsRoot,
      log: silentLog,
      warn: silentWarn,
    });
    expect(summary).toMatchObject({ scanned: 1, migrated: 1 });
    expect(JSON.parse(await readFile(chatPath, "utf-8")).conversationBackend).toBe("openclaw");
  });
});
