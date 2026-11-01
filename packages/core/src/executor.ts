import { createHash } from "node:crypto";
import type { OneClickClient, QuoteResponse } from "./oneclick";

/**
 * Executes an ALLOWed quote. The agent never holds keys.
 *
 * Status semantics matter for the budget:
 *  - not_sent: nothing left the wallet, the reservation can be released
 *  - submitted / simulated: funds moved (or were simulated to move)
 *  - pending_approval: custody holds it for a human; funds may still move
 *  - unknown: a transfer request was issued and its outcome is unclear; treated as spent
 */
export type ExecutionStatus = "submitted" | "pending_approval" | "simulated" | "not_sent" | "unknown";

export interface ExecutionResult {
  status: ExecutionStatus;
  txHash?: string;
  details?: unknown;
}

export interface Executor {
  readonly mode: "live" | "offline";
  execute(quote: QuoteResponse): Promise<ExecutionResult>;
}

export class SimulatedExecutor implements Executor {
  readonly mode = "offline" as const;
  async execute(quote: QuoteResponse): Promise<ExecutionResult> {
    const txHash = `sim-${createHash("sha256").update(quote.correlationId).digest("hex").slice(0, 16)}`;
    return { status: "simulated", txHash, details: { depositAddress: quote.quote.depositAddress } };
  }
}

/**
 * Live path: transfer the origin NEP-141 token from the OutLayer custody wallet to
 * the 1Click deposit address (ft_transfer), then submit the tx hash to 1Click.
 * Scope: origin assets that are NEP-141 tokens on NEAR.
 */
export class OutLayerExecutor implements Executor {
  readonly mode = "live" as const;

  constructor(
    private readonly oneclick: OneClickClient,
    private readonly apiKey = process.env.OUTLAYER_API_KEY ?? "",
    private readonly baseUrl = process.env.OUTLAYER_BASE_URL ?? "https://api.outlayer.ai",
    private readonly rpcUrl = process.env.NEAR_RPC_URL ?? "https://rpc.mainnet.near.org",
  ) {
    if (!apiKey) throw new Error("OUTLAYER_API_KEY is required for live execution");
  }

  private async outlayer<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OutLayer ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  private async viewCall(contract: string, method: string, args: unknown): Promise<unknown> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "sealed-intent",
        method: "query",
        params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
      }),
    });
    const json = (await res.json()) as { result?: { result: number[] }; error?: unknown };
    if (!json.result) throw new Error(`view ${contract}.${method} failed: ${JSON.stringify(json.error).slice(0, 200)}`);
    return JSON.parse(Buffer.from(json.result.result).toString("utf8"));
  }

  async execute(quote: QuoteResponse): Promise<ExecutionResult> {
    const depositAddress = quote.quote.depositAddress;
    if (!depositAddress) return { status: "not_sent", details: "live quote has no depositAddress" };
    const origin = quote.quoteRequest.originAsset;
    if (!origin.startsWith("nep141:")) return { status: "not_sent", details: `origin ${origin} is not a NEP-141 token on NEAR` };
    const contract = origin.slice("nep141:".length);

    try {
      const storage = await this.viewCall(contract, "storage_balance_of", { account_id: depositAddress });
      if (storage === null) {
        await this.outlayer("/wallet/v1/call", {
          receiver_id: contract,
          method_name: "storage_deposit",
          args: { account_id: depositAddress, registration_only: true },
          deposit: "1250000000000000000000",
        });
      }
    } catch (err) {
      return { status: "not_sent", details: (err as Error).message };
    }

    // From here on a transfer request has been issued: any failure is "unknown", not "not_sent".
    let transfer: Record<string, unknown>;
    try {
      transfer = await this.outlayer<Record<string, unknown>>("/wallet/v1/call", {
        receiver_id: contract,
        method_name: "ft_transfer",
        args: { receiver_id: depositAddress, amount: quote.quote.amountIn, memo: quote.quote.depositMemo },
        deposit: "1",
      });
    } catch (err) {
      return { status: "unknown", details: (err as Error).message };
    }
    if (transfer.status === "pending_approval") return { status: "pending_approval", details: transfer };

    const txHash = [transfer.tx_hash, transfer.transaction_hash, transfer.hash].find((v): v is string => typeof v === "string");
    if (!txHash) return { status: "unknown", details: transfer };

    const notes: string[] = [];
    try {
      const sender = await this.outlayer<{ address?: string; near_account_id?: string }>("/wallet/v1/address?chain=near");
      await this.oneclick.submitDeposit?.(txHash, depositAddress, sender.address ?? sender.near_account_id);
    } catch (err) {
      notes.push(`deposit submit failed, funds already sent: ${(err as Error).message}`);
    }
    return { status: "submitted", txHash, details: { ...transfer, notes } };
  }
}
