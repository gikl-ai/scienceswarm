import path from "node:path";
import { getScienceSwarmStateRoot } from "@/lib/scienceswarm-paths";
import type { ChannelSessionState } from "@/brain/types";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./atomic-json";

function assertSafeUserId(userId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
    throw new Error("Invalid channel userId");
  }

  return userId;
}

export function getChannelSessionPath(
  channel: "telegram",
  userId: string,
  root = getScienceSwarmStateRoot(),
): string {
  return path.join(root, "channels", channel, `${assertSafeUserId(userId)}.json`);
}

export async function readChannelSession(
  channel: "telegram",
  userId: string,
  root = getScienceSwarmStateRoot(),
): Promise<ChannelSessionState | null> {
  return readJsonFile<ChannelSessionState>(getChannelSessionPath(channel, userId, root));
}

export async function writeChannelSession(
  state: ChannelSessionState,
  root = getScienceSwarmStateRoot(),
): Promise<ChannelSessionState> {
  await writeJsonFile(getChannelSessionPath(state.channel, state.userId, root), state);
  return state;
}

export async function updateChannelSession(
  channel: "telegram",
  userId: string,
  updater: (current: ChannelSessionState | null) => ChannelSessionState,
  root = getScienceSwarmStateRoot(),
): Promise<ChannelSessionState> {
  return updateJsonFile<ChannelSessionState>(getChannelSessionPath(channel, userId, root), updater);
}
