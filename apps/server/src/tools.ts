import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { tokenOf, toSmallest, type Network } from "./setup";

/** Where the tools send their work: in this process (offline demo) or a separate REST service (real use). */
export interface McpBackend {
  preflight(intent: Record<string, unknown>): Promise<unknown>;
  execute(decisionId: string): Promise<unknown>;
  report(args: { account: string; reason: string; evidence: string[] }): Promise<unknown>;
  receipt(decisionId: string): Promise<unknown>;
}

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const explorer = (network: Network, hash: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;

/** What happened to a payment, in words an agent can pass on to its user. */
function outcome(network: Network, decisionId: string, x: Record<string, any>) {
  if (x.status === "submitted" || x.status === "simulated") return { result: x.status === "simulated" ? "paid (simulated, offline mode)" : "paid", decisionId, txHash: x.txHash, explorer: x.txHash ? explorer(network, x.txHash) : undefined };
  if (x.status === "pending_approval" || /approval/.test(String(x.details ?? ""))) return { result: "still waiting for the owner", decisionId, next: "The owner has not approved it yet. Ask the user to approve it, then call finish_payment again." };
  if (x.status === "not_sent") return { result: "not sent", decisionId, reason: x.refusedByCustody ? "the custody wallet refused it" : "it was not sent", details: x.details };
  return { result: x.status ?? "error", decisionId, details: x.error ?? x.details };
}

/** There is deliberately no approve tool: approving a WARN is a human action with the owner token. */
export function registerTools(server: McpServer, backend: McpBackend, network: Network = "mainnet"): void {
  server.registerTool(
    "pay",
    {
      title: "Pay someone, checked by SeIn first",
      description:
        "The simple way to send money. Give the receiver, the amount in normal units (0.5 means half a token) and the token (NEAR, USDC or wNEAR). SeIn checks it against the owner's secret rules before anything moves. If the result is paid, tell the user. If it is waiting for the owner, tell the user the owner must approve it with their wallet, and call finish_payment with the decisionId once they say it is approved. If it is refused, nothing was sent: tell the user and do not retry it another way.",
      inputSchema: {
        to: z.string().describe("the NEAR account that receives the money, e.g. bob.near"),
        amount: z.string().describe("normal units, e.g. 0.5"),
        token: z.string().default("NEAR").describe("NEAR, USDC or wNEAR"),
        taskText: z.string().describe("the user's instruction that led to this payment, word for word"),
      },
    },
    async ({ to, amount, token, taskText }) => {
      const t = tokenOf(network, token);
      if (!t) return text({ result: "refused", reason: `unknown token ${token}; use NEAR, USDC or wNEAR` });
      let units: string;
      try {
        units = toSmallest(amount, t.decimals);
      } catch (err) {
        return text({ result: "refused", reason: (err as Error).message });
      }
      const d = (await backend.preflight({ kind: "transfer", token: t.assetId, amount: units, recipient: to, taskText })) as Record<string, any>;
      if (d.verdict === "ALLOW") return text(outcome(network, d.decisionId, (await backend.execute(d.decisionId)) as Record<string, any>));
      if (d.verdict === "WARN") return text({ result: "waiting for the owner", decisionId: d.decisionId, next: "The owner has to approve this payment with their NEAR wallet. Tell the user. When they say it is approved, call finish_payment with this decisionId." });
      if (d.verdict === "BLOCK") return text({ result: "refused", decisionId: d.decisionId, reasons: d.reasonCodes, next: "Nothing was sent. Tell the user; do not try again in another form." });
      return text({ result: "error", details: d });
    },
  );

  server.registerTool(
    "finish_payment",
    {
      title: "Send a payment the owner approved",
      description: "Call this with the decisionId from pay after the user says the owner approved it. It sends the payment, or says it is still waiting.",
      inputSchema: { decisionId: z.string() },
    },
    async ({ decisionId }) => text(outcome(network, decisionId, (await backend.execute(decisionId)) as Record<string, any>)),
  );

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
