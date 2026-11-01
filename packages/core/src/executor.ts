import { createHash } from "node:crypto";
import type { OneClickClient, QuoteResponse } from "./oneclick";

/** The asset id SeIn uses for plain NEAR on the wallet's own account. */
export const NATIVE = "native";

/**
 * Executes an ALLOWed action. The agent never holds keys.
 *
 * Status semantics matter for the budget:
 *  - not_sent: nothing was signed, the reservation can be released
 *  - failed_on_chain: signed and sent, the chain failed it; the tx hash is real, no value moved
 *  - submitted / simulated: funds moved (or were simulated to move)
 *  - pending_approval: custody holds it for a human; funds may still move
 *  - unknown: a request was issued and its outcome is unclear; treated as spent, reconciliation settles it
 */
export type ExecutionStatus = "submitted" | "pending_approval" | "simulated" | "not_sent" | "failed_on_chain" | "unknown";

/** What the chain itself says about a finished transaction. */
export interface ChainProof {
  network: string;
  signer: string;
  receiver: string;
  blockHash: string;
  final: boolean;
}

export interface ExecutionResult {
  status: ExecutionStatus;
  txHash?: string;
  /** every transaction this action produced, the payment last; reconciliation needs all of them */
  txHashes?: string[];
  /** the custody layer refused it, for example its own policy */
  refusedByCustody?: boolean;
  chain?: ChainProof;
  details?: unknown;
}

export type ExecutableAction =
  | { kind: "swap"; quote: QuoteResponse }
  | { kind: "transfer"; token: string; recipient: string; amount: string; memo?: string }
  | { kind: "call"; contract: string; method: string; args: Record<string, unknown>; depositYocto: string };

export interface ExecuteContext {
  /** the same key on a retry means the custody layer will not send twice */
  idempotencyKey?: string;
}

export interface Executor {
  readonly mode: "live" | "offline";
  execute(action: ExecutableAction, ctx?: ExecuteContext): Promise<ExecutionResult>;
}

export class SimulatedExecutor implements Executor {
  readonly mode = "offline" as const;
  async execute(action: ExecutableAction): Promise<ExecutionResult> {
    const seed = action.kind === "swap" ? action.quote.correlationId : JSON.stringify(action);
    const txHash = `sim-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
    return { status: "simulated", txHash, details: action.kind === "swap" ? { depositAddress: action.quote.quote.depositAddress } : { kind: action.kind } };
  }
}

type CustodyReply = { http: number; body: Record<string, unknown> };

/** Reads what custody answered. Only a clear refusal or a clear hash is believed. */
export function classifyCustodyReply({ http, body }: CustodyReply): ExecutionResult {
  const txHash = typeof body.tx_hash === "string" ? body.tx_hash : undefined;
  const error = typeof body.error === "string" ? body.error : undefined;
  const details = { http, error, message: body.message, status: body.status, request_id: body.request_id };
  // signed and on chain, then failed there
  if (http === 422 || error === "onchain_tx_failed") return { status: "failed_on_chain", txHash, txHashes: txHash ? [txHash] : [], details };
  if (http === 403) return { status: "not_sent", refusedByCustody: true, details };
  // bad request, bad key, wallet busy or daily ceiling: refused before anything was signed
  if (http === 400 || http === 401 || http === 409 || http === 429) return { status: "not_sent", details };
  // a repeated key means an earlier attempt exists whose result we do not hold
  if (error === "duplicate_idempotency_key") return { status: "unknown", details };
  if (http >= 300 || error) return { status: "unknown", txHash, txHashes: txHash ? [txHash] : [], details };
  if (body.status === "pending_approval") return { status: "pending_approval", details: { ...details, approval_id: body.approval_id } };
  if (body.status === "failed") return { status: "failed_on_chain", txHash, txHashes: txHash ? [txHash] : [], details };
  if (txHash) return { status: "submitted", txHash, txHashes: [txHash], details };
  return { status: "unknown", details };
}

/**
 * Live path through OutLayer custody. Swaps move the origin NEP-141 token to the 1Click
 * deposit address and report the tx; transfers use the native route or ft_transfer; calls go to /wallet/v1/call.
 * A submitted transaction is then read back from the chain until final.
 */
export class OutLayerExecutor implements Executor {
  readonly mode = "live" as const;

  constructor(
    private readonly oneclick: OneClickClient,
    private readonly apiKey = process.env.OUTLAYER_API_KEY ?? "",
    private readonly baseUrl = process.env.OUTLAYER_BASE_URL ?? "https://api.outlayer.ai",
    private readonly rpcUrl = process.env.NEAR_RPC_URL ?? "https://rpc.mainnet.near.org",
    private readonly network = process.env.SEALED_NETWORK ?? "mainnet",
    private readonly finalityTimeoutMs = 45_000,
  ) {
    if (!apiKey) throw new Error("OUTLAYER_API_KEY is required for live execution");
  }

  private async post(path: string, body: unknown, idempotencyKey?: string): Promise<CustodyReply> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...(idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return { http: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { http: res.status, body: { error: "unreadable_reply", message: text.slice(0, 200) } };
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`OutLayer ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  private async rpc<T>(method: string, params: unknown): Promise<{ result?: T; error?: unknown }> {
    const res = await fetch(this.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "sealed-intent", method, params }) });
    return (await res.json()) as { result?: T; error?: unknown };
  }

  private async viewCall(contract: string, method: string, args: unknown): Promise<unknown> {
    const json = await this.rpc<{ result: number[] }>("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    if (!json.result) throw new Error(`view ${contract}.${method} failed: ${JSON.stringify(json.error).slice(0, 200)}`);
    return JSON.parse(Buffer.from(json.result.result).toString("utf8"));
  }

  private walletAccount?: string;
  private async sender(): Promise<string> {
    if (!this.walletAccount) {
      const a = await this.get<{ address?: string; near_account_id?: string }>("/wallet/v1/address?chain=near");
      this.walletAccount = a.address ?? a.near_account_id ?? "";
    }
    return this.walletAccount;
  }

  /** Waits until the chain calls the transaction final and reports what it says happened. */
  private async settle(result: ExecutionResult): Promise<ExecutionResult> {
    if (result.status !== "submitted" || !result.txHash) return result;
    type TxView = { status?: { Failure?: unknown }; transaction?: { signer_id: string; receiver_id: string }; transaction_outcome?: { block_hash: string } };
    const until = Date.now() + this.finalityTimeoutMs;
    const sender = await this.sender().catch(() => "");
    while (Date.now() < until) {
      const j = await this.rpc<TxView>("tx", { tx_hash: result.txHash, sender_account_id: sender, wait_until: "FINAL" }).catch(() => ({}) as { result?: TxView });
      const t = j.result;
      if (t?.transaction && t.transaction_outcome) {
        const chain: ChainProof = { network: this.network, signer: t.transaction.signer_id, receiver: t.transaction.receiver_id, blockHash: t.transaction_outcome.block_hash, final: true };
        return t.status?.Failure ? { ...result, status: "failed_on_chain", chain, details: { ...(result.details as object), failure: t.status.Failure } } : { ...result, chain };
      }
      await new Promise((d) => setTimeout(d, 1500));
    }
    return { ...result, details: { ...(result.details as object), finality: "not confirmed in time" } };
  }

  /** Registers storage if needed (nothing paid yet), then issues the transfer. */
  private async ftTransfer(contract: string, to: string, amount: string, memo: string | undefined, ctx: ExecuteContext): Promise<ExecutionResult> {
    const before: string[] = [];
    try {
      const storage = await this.viewCall(contract, "storage_balance_of", { account_id: to });
      if (storage === null) {
        const reg = classifyCustodyReply(await this.post("/wallet/v1/call", { receiver_id: contract, method_name: "storage_deposit", args: { account_id: to, registration_only: true }, deposit: "1250000000000000000000" }, ctx.idempotencyKey && `${ctx.idempotencyKey}:storage`));
        if (reg.status !== "submitted") return reg;
        before.push(reg.txHash!);
      }
    } catch (err) {
      return { status: "not_sent", details: (err as Error).message };
    }
    const paid = await this.call(contract, "ft_transfer", { receiver_id: to, amount, memo }, "1", ctx);
    return before.length ? { ...paid, txHashes: [...before, ...(paid.txHashes ?? [])] } : paid;
  }

  /** From the moment the request is issued, a failure we cannot read is "unknown", never "not_sent". */
  private async call(receiverId: string, method: string, args: Record<string, unknown>, depositYocto: string, ctx: ExecuteContext): Promise<ExecutionResult> {
    try {
      return classifyCustodyReply(await this.post("/wallet/v1/call", { receiver_id: receiverId, method_name: method, args, deposit: depositYocto }, ctx.idempotencyKey));
    } catch (err) {
      return { status: "unknown", details: (err as Error).message };
    }
  }

  private async native(to: string, amount: string, ctx: ExecuteContext): Promise<ExecutionResult> {
    try {
      return classifyCustodyReply(await this.post("/wallet/v1/transfer", { chain: "near", to, amount }, ctx.idempotencyKey));
    } catch (err) {
      return { status: "unknown", details: (err as Error).message };
    }
  }

  async execute(action: ExecutableAction, ctx: ExecuteContext = {}): Promise<ExecutionResult> {
    return this.settle(await this.send(action, ctx));
  }

  private async send(action: ExecutableAction, ctx: ExecuteContext): Promise<ExecutionResult> {
    if (action.kind === "call") return this.call(action.contract, action.method, action.args, action.depositYocto, ctx);
    if (action.kind === "transfer" && action.token === NATIVE) return this.native(action.recipient, action.amount, ctx);

    const asset = action.kind === "swap" ? action.quote.quoteRequest.originAsset : action.token;
    if (!asset.startsWith("nep141:")) return { status: "not_sent", details: `${asset} is not a NEP-141 token on NEAR` };
    const contract = asset.slice("nep141:".length);

    if (action.kind === "transfer") return this.ftTransfer(contract, action.recipient, action.amount, action.memo, ctx);

    const depositAddress = action.quote.quote.depositAddress;
    if (!depositAddress) return { status: "not_sent", details: "live quote has no depositAddress" };
    const result = await this.ftTransfer(contract, depositAddress, action.quote.quote.amountIn, action.quote.quote.depositMemo, ctx);
    if (result.status !== "submitted") return result;
    const notes: string[] = [];
    try {
      await this.oneclick.submitDeposit?.(result.txHash!, depositAddress, await this.sender());
    } catch (err) {
      notes.push(`deposit submit failed, funds already sent: ${(err as Error).message}`);
    }
    return { ...result, details: { ...(result.details as object), notes } };
  }
}
