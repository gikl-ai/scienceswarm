import { getScienceSwarmBrainRoot } from "@/lib/scienceswarm-paths";

export function getRadarStateDir(): string {
  return process.env.RADAR_STATE_DIR || process.env.BRAIN_ROOT || getScienceSwarmBrainRoot();
}
