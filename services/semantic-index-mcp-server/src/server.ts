import { config as loadEnv } from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpSemanticQueryPort } from "./http-semantic-query-port.js";
import { createSemanticIndexMcpServer } from "./semantic-index-mcp-server.js";

loadEnv();

async function main(): Promise<void> {
  const endpoint = process.env.SEMANTIC_QUERY_PORT_URL?.trim();
  if (!endpoint) {
    throw new Error("SEMANTIC_QUERY_PORT_URL is required; the VS Code host owns the semantic index runtime.");
  }
  const queryPort = new HttpSemanticQueryPort({
    endpoint,
    bearerToken: process.env.SEMANTIC_QUERY_PORT_TOKEN,
  });
  const server = createSemanticIndexMcpServer({ queryPort });
  await server.connect(new StdioServerTransport());
  console.error("ForeXplore semantic-index MCP server is running on stdio.");
}

void main().catch((error) => {
  console.error("ForeXplore semantic-index MCP server failed:", error);
  process.exitCode = 1;
});
