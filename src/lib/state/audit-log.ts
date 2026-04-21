import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import { getScienceSwarmStateRoot } from "@/lib/scienceswarm-paths";
import type { PrivacyMode } from "@/brain/types";

export interface AuditLogEvent {
  ts: string;
  kind: string;
  action: string;
  project?: string;
  captureId?: string;
  route?: string;
  outcome?: string;
  privacy?: PrivacyMode;
  details?: Record<string, unknown>;
}

export function getAuditLogPath(root = getScienceSwarmStateRoot()): string {
  return path.join(root, "audit-log.jsonl");
}

export async function appendAuditEvent(
  event: AuditLogEvent,
  root = getScienceSwarmStateRoot(),
): Promise<void> {
  const logPath = getAuditLogPath(root);
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(event)}\n`, "utf-8");
}
