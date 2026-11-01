import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** Where the tools send their work: in this process (offline demo) or a separate REST service (real use). */
export interface McpBackend {
  preflight(intent: Record<string, unknown>): Promise<unknown>;
  execute(decisionId: string): Promise<unknown>;
  report(args: { account: string; reason: string; evidence: string[] }): Promise<unknown>;
  receipt(decisionId: string): Promise<unknown>;
}

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** There is deliberately no approve tool: approving a WARN is a human action with the owner token. */
export function registerTools(server: McpServer, backend: McpBackend): void {
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
        taskText: z.string().optional().describe("the instruction you received, verbatim; without it a human must review"),
      },
    },
    async (args) => text(await backend.preflight({ kind: "swap", ...args })),
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
        taskText: z.string().optional().describe("the instruction you received, verbatim; without it a human must review"),
      },
    },
    async (args) => text(await backend.preflight({ kind: "transfer", ...args })),
  );

  server.registerTool(
    "preflight_call",
    {
      title: "Check a contract call before it is signed",
      description: "Declare a function call. Only allow-listed contracts and methods pass. Returns ALLOW, WARN or BLOCK.",
      inputSchema: {
        contract: z.string(),
        method: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        depositYocto: z.string().optional(),
        purpose: z.string().optional(),
        taskText: z.string().optional(),
      },
    },
    async (args) => text(await backend.preflight({ kind: "call", ...args })),
  );

  server.registerTool(
    "execute_swap",
    {
      title: "Execute an allowed decision",
      description: "Executes a decision that a preflight tool ALLOWed (or a human approved). Keys never leave the custody enclave.",
      inputSchema: { decisionId: z.string() },
    },
    async ({ decisionId }) => text(await backend.execute(decisionId)),
  );

  server.registerTool(
    "report_counterparty",
    {
      title: "Report a bad counterparty to the shared blocklist",
      description: "Report an account. Evidence (tx hash, receipt id, URL) is required. Payments to it go to a human for review; it blocks only after the owner confirms the report.",
      inputSchema: { account: z.string(), reason: z.string(), evidence: z.array(z.string()).min(1) },
    },
    async (args) => text(await backend.report(args)),
  );

  server.registerTool(
    "get_receipt",
    {
      title: "Get the public receipt for a decision",
      description: "Signed receipt: verdict, reason codes, hashes of private fields, TEE evidence. Safe to share.",
      inputSchema: { decisionId: z.string() },
    },
    async ({ decisionId }) => text(await backend.receipt(decisionId)),
  );
}
