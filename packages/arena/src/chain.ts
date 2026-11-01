import type { ChainReader } from "@sealed-intent/core";
import type { ChainEvent, LedgerAccount, Snapshot, TokenSpec } from "./ledger";

export type TxResult = { ok: true; txHash?: string } | { ok: false; error: string };
export type SwapResult = { ok: true; amountOut: bigint; txHash?: string } | { ok: false; error: string };
type Maybe<T> = T | Promise<T>;

/**
 * What a lane needs from a chain. The in-memory ledger answers synchronously, the
 * near-sandbox adapter asynchronously; callers always await.
 */
export interface ArenaChain extends ChainReader {
  readonly kind: "ledger" | "sandbox";
  readonly tokens: Record<string, TokenSpec>;
  readonly events: ChainEvent[];
  blockHeight(): number;
  balance(token: string, id: string): Maybe<bigint>;
  transfer(token: string, from: string, to: string, amount: bigint, opts?: { memo?: string; yocto?: boolean }): Maybe<TxResult>;
  swap(from: string, tokenIn: string, amountIn: bigint, tokenOut: string, to: string, haircutBps?: number): Maybe<SwapResult>;
  addKey(account: string, publicKey: string, permission: "full" | "function-call"): Maybe<void>;
  deploy(account: string, codeHash: string): Maybe<void>;
  keys(account: string): Maybe<LedgerAccount["keys"]>;
  codeHash(account: string): Maybe<string | null>;
  /** the hash this chain shows for a catalog code label (the ledger uses labels as hashes) */
  codeHashFor(label: string): Maybe<string>;
  snapshot(): Maybe<Snapshot>;
  /** back to the world as built, before any scenario */
  reset(): Maybe<void>;
  close(): Maybe<void>;
}
