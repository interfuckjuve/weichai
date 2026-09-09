import { config as loadEnv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpSemanticQueryPort } from "./http-semantic-query-port.js";
import { HttpTaskRetrievalPort } from "./http-task-retrieval-port.js";
import { createSemanticIndexMcpServer } from "./semantic-index-mcp-server.js";

// dotenv environment flags override its options; stdio stdout is protocol-only.
process.env.DOTENV_CONFIG_QUIET = "true";
process.env.DOTENV_CONFIG_DEBUG = "false";
loadEnv({ quiet: true, debug: false });

async function main(): Promise<void> {
  const endpoint = process.env.SEMANTIC_QUERY_PORT_URL?.trim();
  if (!endpoint) {
    throw new Error("SEMANTIC_QUERY_PORT_URL is required; the VS Code host owns the semantic index runtime.");
  }
  const queryPort = new HttpSemanticQueryPort({
    endpoint,
    bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN,
  });
  const hostUrl = new URL(endpoint);
  const taskRetrieval = hostUrl.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(hostUrl.hostname)
    ? new HttpTaskRetrievalPort({ endpoint, bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN }) : undefined;
  const server = createSemanticIndexMcpServer({ queryPort, taskRetrieval });
  await server.connect(new StdioServerTransport());
  console.error("ForeXplore semantic-index MCP server is running on stdio.");
}

void main().catch((error) => {
  console.error("ForeXplore semantic-index MCP server failed:", error);
  process.exitCode = 1;
});
