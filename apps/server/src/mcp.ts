#!/usr/bin/env tsx
/**
 * MCP server (stdio). One process serves one agent, named by SEALED_AGENT_ID.
 * Give these tools to an agent INSTEAD of raw wallet/swap tools.
 *
 * Claude Code:  claude mcp add sealed-intent -- pnpm --dir /path/to/sealed-intent -s mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReceiptStore } from "@sealed-intent/core";
import { z } from "zod";
import { createApp } from "./app";

const { preflight, blocklist, offline } = createApp();
const agentId = process.env.SEALED_AGENT_ID ?? "mcp-agent";
const receipts = new ReceiptStore();
const server = new McpServer({ name: "sealed-intent", version: "0.1.0" });

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

server.registerTool(
  "preflight_swap",
  {
    title: "Check a swap before any money moves",
    description:
      "Declare what you want to swap. Sealed Intent fetches and checks the NEAR Intents quote and the receiver against a secret policy and returns ALLOW, WARN (a human must approve first) or BLOCK with generic reason codes. Call execute_swap with the decisionId only after ALLOW, or after a human approved a WARN.",
    inputSchema: {
      tokenIn: z.string().describe("1Click assetId, e.g. nep141:wrap.near"),
      tokenOut: z.string(),
      amountIn: z.string().describe("smallest units"),
      recipient: z.string(),
      refundTo: z.string(),
      purpose: z.string().optional(),
      taskText: z.string().optional().describe("the instruction you received, verbatim"),
    },
  },
  async (args) => {
    const { metrics: _m, receiptPath: _p, ...decision } = await preflight.evaluate({ agentId, intent: { kind: "swap", ...args } });
    return text({ mode: offline ? "offline" : "live", ...decision });
  },
);

server.registerTool(
  "preflight_transfer",
  {
    title: "Check a token transfer before any money moves",
    description: "Declare a NEP-141 transfer. Returns ALLOW, WARN or BLOCK with generic reason codes. Execute with execute_swap after ALLOW or human approval.",
    inputSchema: {
      token: z.string().describe("1Click assetId, e.g. nep141:wrap.near"),
      amount: z.string().describe("smallest units"),
      recipient: z.string(),
      memo: z.string().optional(),
      purpose: z.string().optional(),
      taskText: z.string().optional().describe("the instruction you received, verbatim"),
    },
  },
  async (args) => {
    const { metrics: _m, receiptPath: _p, ...decision } = await preflight.evaluate({ agentId, intent: { kind: "transfer", ...args } });
    return text({ mode: offline ? "offline" : "live", ...decision });
  },
);

server.registerTool(
  "preflight_call",
  {
    title: "Check a contract call before it is signed",
    description: "Declare a function call. Only allow-listed contracts and methods pass. Returns ALLOW, WARN or BLOCK.",
    inputSchema: {
      contract: z.string(),
      method: z.string(),
      args: z.record(z.unknown()).optional(),
      depositYocto: z.string().optional(),
      purpose: z.string().optional(),
      taskText: z.string().optional(),
    },
  },
  async (args) => {
    const { metrics: _m, receiptPath: _p, ...decision } = await preflight.evaluate({ agentId, intent: { kind: "call", ...args } });
    return text({ mode: offline ? "offline" : "live", ...decision });
  },
);

server.registerTool(
  "execute_swap",
  {
    title: "Execute an allowed decision",
    description: "Executes a decision that a preflight tool ALLOWed (or a human approved). Keys never leave the custody enclave.",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => text(await preflight.execute(decisionId, agentId)),
);

server.registerTool(
  "report_counterparty",
  {
    title: "Report a bad counterparty to the shared blocklist",
    description: "Add an account to the shared blocklist. Evidence (tx hash, receipt id, URL) is required. Other agents will be blocked from paying it.",
    inputSchema: { account: z.string(), reason: z.string(), evidence: z.array(z.string()).min(1) },
  },
  async (args) => text(blocklist.report({ ...args, reportedBy: agentId })),
);

// There is deliberately no approve tool: approving a WARN is a human action with the owner token.

server.registerTool(
  "get_receipt",
  {
    title: "Get the public receipt for a decision",
    description: "Signed receipt: verdict, reason codes, hashes of private fields, TEE evidence. Safe to share.",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => text(receipts.load(decisionId) ?? { error: "not found" }),
);

await server.connect(new StdioServerTransport());
