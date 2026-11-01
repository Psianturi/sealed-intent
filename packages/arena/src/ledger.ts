import type { ChainAccountInfo, ChainReader } from "@sealed-intent/core";

/**
 * In-memory chain with the NEP-141 rules that matter to the referee: balances, account
 * existence, access keys, contract code hashes. Deterministic and fast. Labelled
 * SIMULATED LEDGER wherever it is shown; the near-sandbox adapter is the real chain.
 */
export interface LedgerAccount {
  balances: Record<string, bigint>;
  keys: { publicKey: string; permission: "full" | "function-call" }[];
  codeHash: string | null;
  createdAt: number;
}

export interface TokenSpec {
  decimals: number;
  priceUsd: number;
}

export type ChainEvent =
  | { type: "transfer"; token: string; from: string; to: string; amount: string; memo?: string }
  | { type: "swap"; from: string; tokenIn: string; amountIn: string; tokenOut: string; amountOut: string; lostTo?: string; lost?: string }
  | { type: "add_key"; account: string; publicKey: string; permission: string }
  | { type: "deploy"; account: string; codeHash: string }
  | { type: "create"; account: string };

export type Snapshot = Record<string, { balances: Record<string, string>; keys: LedgerAccount["keys"]; codeHash: string | null; createdAt: number }>;

export class LedgerChain implements ChainReader {
  readonly kind = "ledger" as const;
  private accounts = new Map<string, LedgerAccount>();
  private block = 1;
  readonly events: ChainEvent[] = [];
  /** fraction of value a swap loses to the route, in bps; the loss goes to `swapLossTo` */
  swapHaircutBps = 20;
  swapLossTo = "mev-pool.arena";

  constructor(readonly tokens: Record<string, TokenSpec>, private now = () => Date.now()) {}

  blockHeight(): number {
    return this.block;
  }

  createAccount(id: string, opts: { createdAt?: number; codeHash?: string | null; keys?: LedgerAccount["keys"] } = {}): void {
    if (this.accounts.has(id)) return;
    this.accounts.set(id, { balances: {}, keys: opts.keys ?? [{ publicKey: `ed25519:${id}-owner`, permission: "full" }], codeHash: opts.codeHash ?? null, createdAt: opts.createdAt ?? this.now() });
    this.events.push({ type: "create", account: id });
    this.block++;
  }

  exists(id: string): boolean {
    return this.accounts.has(id);
  }

  mint(token: string, to: string, amount: bigint): void {
    const a = this.must(to);
    a.balances[token] = (a.balances[token] ?? 0n) + amount;
  }

  balance(token: string, id: string): bigint {
    return this.accounts.get(id)?.balances[token] ?? 0n;
  }

  /** NEP-141 ft_transfer: sender and receiver must exist, balance must cover, 1 yocto must be attached. */
  transfer(token: string, from: string, to: string, amount: bigint, opts: { memo?: string; yocto?: boolean } = { yocto: true }): { ok: true } | { ok: false; error: string } {
    if (!this.tokens[token]) return { ok: false, error: `unknown token ${token}` };
    if (!this.accounts.has(from)) return { ok: false, error: `sender ${from} does not exist` };
    if (!this.accounts.has(to)) return { ok: false, error: `receiver ${to} is not registered` };
    if (opts.yocto === false) return { ok: false, error: "Requires attached deposit of exactly 1 yoctoNEAR" };
    if (amount <= 0n) return { ok: false, error: "amount must be positive" };
    const a = this.must(from);
    if ((a.balances[token] ?? 0n) < amount) return { ok: false, error: "The account doesn't have enough balance" };
    a.balances[token] = (a.balances[token] ?? 0n) - amount;
    this.mint(token, to, amount);
    this.events.push({ type: "transfer", token, from, to, amount: amount.toString(), memo: opts.memo });
    this.block++;
    return { ok: true };
  }

  /** Converts at reference prices, minus the route haircut which goes to the pool. */
  swap(from: string, tokenIn: string, amountIn: bigint, tokenOut: string, to: string, haircutBps = this.swapHaircutBps): { ok: true; amountOut: bigint } | { ok: false; error: string } {
    const tin = this.tokens[tokenIn];
    const tout = this.tokens[tokenOut];
    if (!tin || !tout) return { ok: false, error: "unknown token" };
    const a = this.must(from);
    if ((a.balances[tokenIn] ?? 0n) < amountIn) return { ok: false, error: "The account doesn't have enough balance" };
    if (!this.accounts.has(to)) return { ok: false, error: `receiver ${to} is not registered` };
    const usd = (Number(amountIn) / 10 ** tin.decimals) * tin.priceUsd;
    const gross = BigInt(Math.floor((usd / tout.priceUsd) * 10 ** tout.decimals));
    const lost = (gross * BigInt(haircutBps)) / 10_000n;
    const amountOut = gross - lost;
    a.balances[tokenIn] = (a.balances[tokenIn] ?? 0n) - amountIn;
    this.mint(tokenOut, to, amountOut);
    if (lost > 0n) {
      this.createAccount(this.swapLossTo);
      this.mint(tokenOut, this.swapLossTo, lost);
    }
    this.events.push({ type: "swap", from, tokenIn, amountIn: amountIn.toString(), tokenOut, amountOut: amountOut.toString(), lostTo: lost > 0n ? this.swapLossTo : undefined, lost: lost.toString() });
    this.block++;
    return { ok: true, amountOut };
  }

  addKey(account: string, publicKey: string, permission: "full" | "function-call"): void {
    this.must(account).keys.push({ publicKey, permission });
    this.events.push({ type: "add_key", account, publicKey, permission });
    this.block++;
  }

  deploy(account: string, codeHash: string): void {
    this.must(account).codeHash = codeHash;
    this.events.push({ type: "deploy", account, codeHash });
    this.block++;
  }

  keys(account: string): LedgerAccount["keys"] {
    return [...(this.accounts.get(account)?.keys ?? [])];
  }

  codeHash(account: string): string | null {
    return this.accounts.get(account)?.codeHash ?? null;
  }

  /** ChainReader for Sealed Intent's counterparty checks. */
  async account(id: string): Promise<ChainAccountInfo | undefined> {
    const a = this.accounts.get(id);
    if (!a) return { exists: false, isContract: false };
    return { exists: true, isContract: a.codeHash !== null, codeHash: a.codeHash ?? undefined, createdAt: new Date(a.createdAt).toISOString() };
  }

  snapshot(): Snapshot {
    const out: Snapshot = {};
    for (const [id, a] of this.accounts) {
      out[id] = { balances: Object.fromEntries(Object.entries(a.balances).map(([t, v]) => [t, v.toString()])), keys: a.keys.map((k) => ({ ...k })), codeHash: a.codeHash, createdAt: a.createdAt };
    }
    return out;
  }

  restore(s: Snapshot): void {
    this.accounts = new Map(Object.entries(s).map(([id, a]) => [id, { balances: Object.fromEntries(Object.entries(a.balances).map(([t, v]) => [t, BigInt(v)])), keys: a.keys.map((k) => ({ ...k })), codeHash: a.codeHash, createdAt: a.createdAt }]));
    this.events.length = 0;
  }

  private must(id: string): LedgerAccount {
    const a = this.accounts.get(id);
    if (!a) throw new Error(`account ${id} does not exist`);
    return a;
  }
}
