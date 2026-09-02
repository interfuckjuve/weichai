import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { loadConfig } from "@forexplore/adaptation-service";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdaptationMcpServer } from "./translation-mcp-server.js";

const mcpEnvPath = fileURLToPath(new URL("../.env", import.meta.url));
const adaptationEnvPath = fileURLToPath(new URL("../../adaptation-service/.env", import.meta.url));

// Explicit process variables win, then the MCP-specific file, then the
// existing adaptation-service file used by the HTTP integration.
loadEnv({ path: mcpEnvPath });
loadEnv({ path: adaptationEnvPath });

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createAdaptationMcpServer({
    apiKey: config.apiKey,
    projectRoot: config.projectRoot,
    analysisRoot: config.analysisRoot,
    skeletonProjectPath: config.skeletonProjectPath,
  });
  await server.connect(new StdioServerTransport());
  console.error("ForeXplore adaptation MCP server is running on stdio.");
}

void main().catch((error) => {
  console.error("ForeXplore adaptation MCP server failed:", error);
  process.exitCode = 1;
});
