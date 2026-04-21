import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ai.scienceswarm.app",
  appName: "ScienceSwarm",
  webDir: "out",
  server: {
    androidScheme: "https",
  },
};

export default config;
