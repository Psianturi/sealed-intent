import { createHash } from "node:crypto";
import type { OneClickClient, QuoteResponse } from "./oneclick";

/**
 * Executes an ALLOWed quote. The agent never holds keys:
 *  - live: OutLayer Agent Custody signs inside a TDX enclave (its own policy is a
 *    second layer), then the deposit tx is reported to 1Click.
 *  - offline: simulated, so the demo runs without funds.
 */
export interface ExecutionResult {
  status: "submitted" | "pending_approval" | "simulated" | "failed";
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
 *
 * Scope: origin assets that are NEP-141 tokens on NEAR (e.g. USDC, USDT, wNEAR).
 * Built from the public OutLayer and 1Click docs; run it first with a tiny amount.
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
    if (!depositAddress) return { status: "failed", details: "live quote has no depositAddress" };
    const origin = quote.quoteRequest.originAsset;
    if (!origin.startsWith("nep141:")) return { status: "failed", details: `origin ${origin} is not a NEP-141 token on NEAR` };
    const contract = origin.slice("nep141:".length);

    // the deposit account needs storage on the token contract before it can receive
    const storage = await this.viewCall(contract, "storage_balance_of", { account_id: depositAddress });
    if (storage === null) {
      await this.outlayer("/wallet/v1/call", {
        receiver_id: contract,
        method_name: "storage_deposit",
        args: { account_id: depositAddress, registration_only: true },
        deposit: "1250000000000000000000",
      });
    }

    const transfer = await this.outlayer<Record<string, unknown>>("/wallet/v1/call", {
      receiver_id: contract,
      method_name: "ft_transfer",
      args: { receiver_id: depositAddress, amount: quote.quote.amountIn, memo: quote.quote.depositMemo },
      deposit: "1",
    });
    if (transfer.status === "pending_approval") return { status: "pending_approval", details: transfer };

    const txHash = [transfer.tx_hash, transfer.transaction_hash, transfer.hash].find((v): v is string => typeof v === "string");
    if (!txHash) return { status: "failed", details: transfer };

    const sender = await this.outlayer<{ address?: string; near_account_id?: string }>("/wallet/v1/address?chain=near");
    await this.oneclick.submitDeposit?.(txHash, depositAddress, sender.address ?? sender.near_account_id);
    return { status: "submitted", txHash, details: transfer };
  }
}
