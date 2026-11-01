#!/usr/bin/env tsx
/**
 * MCP server (stdio) with the whole checker inside the agent host's child process. Fine for the
 * offline demo. For real money run `pnpm rest` as another OS user and give the agent `pnpm mcp:agent`.
 *
 * Claude Code:  claude mcp add sealed-intent -- pnpm --dir /path/to/sealed-intent -s mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentView, ReceiptStore } from "@sealed-intent/core";
import { createApp } from "./app";
import { registerTools } from "./tools";

const { preflight, blocklist, offline } = createApp();
if (!offline && process.env.SEALED_ALLOW_INPROCESS_MCP !== "1") {
  console.error("Refusing to start: in live mode this process would hold the custody key inside the agent host. Run `pnpm rest` as a separate OS user and give the agent `pnpm mcp:agent`.");
  process.exit(3);
}
const agentId = process.env.SEALED_AGENT_ID ?? "mcp-agent";
const receipts = new ReceiptStore();
const server = new McpServer({ name: "sealed-intent", version: "0.1.0" });

registerTools(server, {
  preflight: async (intent) => ({ mode: offline ? "offline" : "live", ...agentView(await preflight.evaluate({ agentId, intent })) }),
  execute: (decisionId) => preflight.execute(decisionId, agentId),
  report: async (args) => blocklist.report({ ...args, reportedBy: agentId }),
  receipt: async (decisionId) => receipts.load(decisionId) ?? { error: "not found" },
});

await server.connect(new StdioServerTransport());
