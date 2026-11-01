import { createHash } from "node:crypto";
import type { OneClickClient, QuoteResponse } from "./oneclick";

/**
 * Executes an ALLOWed action. The agent never holds keys.
 *
 * Status semantics matter for the budget:
 *  - not_sent: nothing left the wallet, the reservation can be released
 *  - submitted / simulated: funds moved (or were simulated to move)
 *  - pending_approval: custody holds it for a human; funds may still move
 *  - unknown: a request was issued and its outcome is unclear; treated as spent
 */
export type ExecutionStatus = "submitted" | "pending_approval" | "simulated" | "not_sent" | "unknown";

export interface ExecutionResult {
  status: ExecutionStatus;
  txHash?: string;
  details?: unknown;
}

export type ExecutableAction =
  | { kind: "swap"; quote: QuoteResponse }
  | { kind: "transfer"; token: string; recipient: string; amount: string; memo?: string }
  | { kind: "call"; contract: string; method: string; args: Record<string, unknown>; depositYocto: string };

export interface Executor {
  readonly mode: "live" | "offline";
  execute(action: ExecutableAction): Promise<ExecutionResult>;
}

export class SimulatedExecutor implements Executor {
  readonly mode = "offline" as const;
  async execute(action: ExecutableAction): Promise<ExecutionResult> {
    const seed = action.kind === "swap" ? action.quote.correlationId : JSON.stringify(action);
    const txHash = `sim-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
    return { status: "simulated", txHash, details: action.kind === "swap" ? { depositAddress: action.quote.quote.depositAddress } : { kind: action.kind } };
  }
}

/**
 * Live path through OutLayer custody. Swaps move the origin NEP-141 token to the 1Click
 * deposit address and report the tx; transfers call ft_transfer; calls go to /wallet/v1/call.
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

  private txHashOf(r: Record<string, unknown>): string | undefined {
    return [r.tx_hash, r.transaction_hash, r.hash].find((v): v is string => typeof v === "string");
  }

  /** Registers storage if needed (nothing sent yet), then issues the transfer. */
  private async ftTransfer(contract: string, to: string, amount: string, memo?: string): Promise<ExecutionResult> {
    try {
      const storage = await this.viewCall(contract, "storage_balance_of", { account_id: to });
      if (storage === null) {
        await this.outlayer("/wallet/v1/call", {
          receiver_id: contract,
          method_name: "storage_deposit",
          args: { account_id: to, registration_only: true },
          deposit: "1250000000000000000000",
        });
      }
    } catch (err) {
      return { status: "not_sent", details: (err as Error).message };
    }
    return this.call(contract, "ft_transfer", { receiver_id: to, amount, memo }, "1");
  }

  /** From the moment the request is issued, any failure is "unknown", never "not_sent". */
  private async call(receiverId: string, method: string, args: Record<string, unknown>, depositYocto: string): Promise<ExecutionResult> {
    let r: Record<string, unknown>;
    try {
      r = await this.outlayer<Record<string, unknown>>("/wallet/v1/call", { receiver_id: receiverId, method_name: method, args, deposit: depositYocto });
    } catch (err) {
      return { status: "unknown", details: (err as Error).message };
    }
    if (r.status === "pending_approval") return { status: "pending_approval", details: r };
    const txHash = this.txHashOf(r);
    return txHash ? { status: "submitted", txHash, details: r } : { status: "unknown", details: r };
  }

  async execute(action: ExecutableAction): Promise<ExecutionResult> {
    if (action.kind === "call") return this.call(action.contract, action.method, action.args, action.depositYocto);

    const asset = action.kind === "swap" ? action.quote.quoteRequest.originAsset : action.token;
    if (!asset.startsWith("nep141:")) return { status: "not_sent", details: `${asset} is not a NEP-141 token on NEAR` };
    const contract = asset.slice("nep141:".length);

    if (action.kind === "transfer") return this.ftTransfer(contract, action.recipient, action.amount, action.memo);

    const depositAddress = action.quote.quote.depositAddress;
    if (!depositAddress) return { status: "not_sent", details: "live quote has no depositAddress" };
    const result = await this.ftTransfer(contract, depositAddress, action.quote.quote.amountIn, action.quote.quote.depositMemo);
    if (result.status !== "submitted") return result;
    const notes: string[] = [];
    try {
      const sender = await this.outlayer<{ address?: string; near_account_id?: string }>("/wallet/v1/address?chain=near");
      await this.oneclick.submitDeposit?.(result.txHash!, depositAddress, sender.address ?? sender.near_account_id);
    } catch (err) {
      notes.push(`deposit submit failed, funds already sent: ${(err as Error).message}`);
    }
    return { ...result, details: { ...(result.details as object), notes } };
  }
}
