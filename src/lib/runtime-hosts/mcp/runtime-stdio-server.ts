import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  handleBrainRead,
  handleBrainSearch,
} from "@/brain/mcp-server";
import { loadBrainConfig } from "@/brain/config";
import {
  createBrainCaptureHandler,
  type BrainCaptureParams,
} from "@/brain/handle-brain-capture";
import { createGbrainClient } from "@/brain/gbrain-client";
import type { BrainConfig } from "@/brain/types";
import { registerRuntimeMcpTools } from "@/lib/runtime-hosts/mcp/server";

function createRuntimeMcpServer(): McpServer {
  const server = new McpServer({
    name: "scienceswarm-runtime",
    version: "0.1.0",
  });
  let config: BrainConfig | null = null;

  function getConfig(): BrainConfig {
    config ??= loadBrainConfig();
    if (!config) {
      throw new Error(
        "Brain not configured. Initialize ~/.scienceswarm/brain or set BRAIN_ROOT.",
      );
    }
    return config;
  }

  const brainCapture = createBrainCaptureHandler({
    client: createGbrainClient(),
  });

  registerRuntimeMcpTools(server, {
    defaultAuth: {
      token: process.env.SCIENCESWARM_RUNTIME_MCP_ACCESS_TOKEN,
    },
    brainSearch: (params) => handleBrainSearch(getConfig(), params),
    brainRead: (params) => handleBrainRead(getConfig(), params),
    brainCapture: (params) => brainCapture(params as BrainCaptureParams),
  });

  return server;
}

async function startRuntimeMcpServer(): Promise<void> {
  const server = createRuntimeMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void startRuntimeMcpServer().catch((error) => {
  process.stderr.write(`Runtime MCP server error: ${error}\n`);
  process.exit(1);
});
