import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ASSET, type ChainAccountInfo } from "@sealed-intent/core";
import type { Near } from "near-kit";
import type { Sandbox, StateSnapshot } from "near-kit/sandbox";
import type { ArenaChain, SwapResult, TxResult } from "./chain";
import type { LaneId } from "./lanes";
import type { ChainEvent, LedgerAccount, Snapshot, TokenSpec } from "./ledger";
import { ACC, TOKENS, WORLD, type WorldSpec } from "./world";

/**
 * The arena world on a real local NEAR node (near-sandbox via near-kit). Linux and
 * macOS only. Arena ids become sub-accounts of the sandbox root; tokens are genuine
 * NEP-141 contracts (wrap.near bytecode, pulled read-only from mainnet and cached).
 * Simulated on purpose: the swap router (a liquidity account at reference prices)
 * and account age (RPC has none, so the chain keeps its own index like an indexer).
 */
const EMPTY_CODE = "11111111111111111111111111111111";
const MAINNET_RPC = process.env.SEALED_ARENA_MAINNET_RPC ?? "https://free.rpc.fastnear.com";
const WASM_DIR = process.env.SEALED_ARENA_WASM_DIR ?? join(homedir(), ".cache", "sealed-arena");
const TOKEN_SLUG: Record<string, string> = { [ASSET.USDC]: "usdc", [ASSET.wNEAR]: "wnear", [ASSET.USDT]: "usdt", [ASSET.FAKE_USDC]: "usdc-official" };
/** two public contracts whose bytecode stands in for the catalog's code labels */
const WASM = { audited: "wrap.near", sweeper: "usdt.tether-token.near" } as const;
type WasmKey = keyof typeof WASM;
const wasmKey = (label: string): WasmKey => (/sweeper/i.test(label) ? "sweeper" : "audited");
const DAY = 86_400_000;
const CODE_SAMPLE = "code-sample.arena";

type Key = { publicKey: string; secretKey: `ed25519:${string}` };
type Kit = typeof import("near-kit");

const errText = (e: unknown): string => {
  const err = e as { details?: unknown; message?: string };
  const d = err?.details ? JSON.stringify(err.details) : "";
  return (err?.message && err.message !== "Server error" ? err.message : d || String(e)).slice(0, 300);
};

async function rpc(url: string, method: string, params: unknown): Promise<{ result?: Record<string, unknown>; error?: { cause?: { name?: string } } }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "arena", method, params }) });
  return (await res.json()) as never;
}

async function loadWasm(account: string): Promise<Uint8Array> {
  mkdirSync(WASM_DIR, { recursive: true });
  const file = join(WASM_DIR, `${account}.wasm`);
  if (existsSync(file)) return new Uint8Array(readFileSync(file));
  const json = await rpc(MAINNET_RPC, "query", { request_type: "view_code", finality: "final", account_id: account });
  const b64 = json.result?.code_base64;
  if (typeof b64 !== "string") throw new Error(`view_code ${account}: ${JSON.stringify(json).slice(0, 200)}`);
  const bytes = Buffer.from(b64, "base64");
  writeFileSync(file, bytes);
  return new Uint8Array(bytes);
}

export class SandboxChain implements ArenaChain {
  readonly kind = "sandbox" as const;
  readonly events: ChainEvent[] = [];
  readonly router = "router.arena";
  swapHaircutBps = 20;
  swapLossTo = "mev-pool.arena";
  private near!: Near;
  private txCount = 0;
  private keys_ = new Map<string, Key>();
  private labelKeys = new Map<string, Key>();
  private createdAt = new Map<string, number>();
  private known = new Set<string>();
  private labelHash: Partial<Record<WasmKey, string>> = {};
  private wasm!: Record<WasmKey, Uint8Array>;
  private pristine?: StateSnapshot;

  private constructor(private readonly sandbox: Sandbox, readonly tokens: Record<string, TokenSpec>, private readonly kit: Kit) {}

  static async start(tokens: Record<string, TokenSpec> = TOKENS): Promise<SandboxChain> {
    const kit = await import("near-kit");
    const { Sandbox } = await import("near-kit/sandbox");
    const sandbox = await Sandbox.start({ detached: false });
    const chain = new SandboxChain(sandbox, tokens, kit);
    chain.near = new kit.Near({ network: sandbox });
    chain.wasm = { audited: await loadWasm(WASM.audited), sweeper: await loadWasm(WASM.sweeper) };
    return chain;
  }

  get rpcUrl(): string {
    return this.sandbox.rpcUrl;
  }

  private get root(): string {
    return this.sandbox.rootAccount.id;
  }

  /** arena ids live under the sandbox root; 64-hex ids get a hashed slug */
  id(arenaId: string): string {
    const slug = TOKEN_SLUG[arenaId] ?? (arenaId.endsWith(".arena") ? arenaId.slice(0, -6) : `x${createHash("sha256").update(arenaId).digest("hex").slice(0, 12)}`);
    return `${slug}.${this.root}`;
  }

  private tx(arenaId: string) {
    const k = this.keys_.get(arenaId);
    if (!k) throw new Error(`no key for ${arenaId}`);
    return this.near.transaction(this.id(arenaId)).signWith(k.secretKey);
  }

  private newKey(): Key {
    const k = this.kit.generateKey();
    return { publicKey: k.publicKey.toString(), secretKey: k.secretKey as `ed25519:${string}` };
  }

  private keyFor(label: string): Key {
    let k = this.labelKeys.get(label);
    if (!k) {
      k = this.newKey();
      this.labelKeys.set(label, k);
    }
    return k;
  }

  blockHeight(): number {
    return this.txCount;
  }

  async build(world: WorldSpec = WORLD, now = Date.UTC(2026, 10, 9)): Promise<void> {
    await Promise.all(Object.keys(this.tokens).map((t) => this.deployToken(t)));
    await Promise.all([
      ...world.accounts.map((a) => this.createAccount(a.id, { createdAt: now - a.ageDays * DAY, codeHash: a.codeHash ?? null, near: a.near })),
      this.createAccount(this.router, { createdAt: now - 500 * DAY, near: "1200 NEAR" }),
      this.createAccount(this.swapLossTo, { createdAt: now - 500 * DAY }),
      this.createAccount(CODE_SAMPLE, { createdAt: now - 500 * DAY, codeHash: "sweeper" }),
    ]);
    await Promise.all(Object.keys(this.tokens).map((t) => this.registerAll(t)));
    await Promise.all(world.mints.map((m) => this.mint(m.token, m.to, BigInt(m.amount))));
    for (const t of Object.keys(this.tokens)) await this.mint(t, this.router, t === ASSET.wNEAR ? 1000n * 10n ** 24n : 10n ** 12n);
    this.labelHash = { audited: (await this.codeHash(ACC.vault)) ?? undefined, sweeper: (await this.codeHash(CODE_SAMPLE)) ?? undefined };
    this.pristine = await this.sandbox.dumpState();
    this.events.length = 0;
  }

  private async deployToken(token: string): Promise<void> {
    const acc = this.id(token);
    const k = this.newKey();
    await this.near.transaction(this.root).createAccount(acc).transfer(acc, "50 NEAR").addKey(k.publicKey, { type: "fullAccess" }).send();
    await this.near.transaction(acc).signWith(k.secretKey).deployContract(acc, this.wasm.audited).functionCall(acc, "new", {}, { gas: "100 Tgas" }).send();
  }

  private async registerAll(token: string): Promise<void> {
    let t = this.near.transaction(this.root);
    for (const id of this.known) t = t.functionCall(this.id(token), "storage_deposit", { account_id: this.id(id) }, { attachedDeposit: "0.01 NEAR", gas: "10 Tgas" });
    await t.send();
  }

  async createAccount(id: string, opts: { createdAt?: number; codeHash?: string | null; near?: `${number} NEAR` } = {}): Promise<void> {
    if (this.known.has(id)) return;
    const k = this.newKey();
    const acc = this.id(id);
    await this.near.transaction(this.root).createAccount(acc).transfer(acc, opts.near ?? "20 NEAR").addKey(k.publicKey, { type: "fullAccess" }).send();
    this.known.add(id);
    this.keys_.set(id, k);
    this.createdAt.set(id, opts.createdAt ?? Date.now());
    if (opts.codeHash) await this.near.transaction(acc).signWith(k.secretKey).deployContract(acc, this.wasm[wasmKey(opts.codeHash)]).send();
    this.events.push({ type: "create", account: id });
  }

  /** the account wraps its own NEAR, so the token balance is minted directly to it */
  async mint(token: string, to: string, amount: bigint): Promise<void> {
    await this.tx(to).functionCall(this.id(token), "near_deposit", {}, { attachedDeposit: amount, gas: "30 Tgas" }).send();
    this.txCount++;
  }

  async balance(token: string, id: string): Promise<bigint> {
    if (!this.tokens[token]) return 0n;
    const v = await this.near.view<string>(this.id(token), "ft_balance_of", { account_id: this.id(id) }, { finality: "optimistic" });
    return BigInt(v ?? "0");
  }

  async transfer(token: string, from: string, to: string, amount: bigint, opts: { memo?: string; yocto?: boolean } = { yocto: true }): Promise<TxResult> {
    if (!this.tokens[token]) return { ok: false, error: `unknown token ${token}` };
    if (!this.keys_.has(from)) return { ok: false, error: `sender ${from} does not exist` };
    if (amount <= 0n) return { ok: false, error: "amount must be positive" };
    try {
      const args = { receiver_id: this.id(to), amount: amount.toString(), ...(opts.memo ? { memo: opts.memo } : {}) };
      const out = await this.tx(from).functionCall(this.id(token), "ft_transfer", args, { gas: "30 Tgas", ...(opts.yocto === false ? {} : { attachedDeposit: "1 yocto" }) }).send();
      this.txCount++;
      this.events.push({ type: "transfer", token, from, to, amount: amount.toString(), memo: opts.memo });
      return { ok: true, txHash: (out as { transaction?: { hash?: string } }).transaction?.hash };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  /** a liquidity account converts at reference prices; the route haircut goes to the pool */
  async swap(from: string, tokenIn: string, amountIn: bigint, tokenOut: string, to: string, haircutBps = this.swapHaircutBps): Promise<SwapResult> {
    const tin = this.tokens[tokenIn];
    const tout = this.tokens[tokenOut];
    if (!tin || !tout) return { ok: false, error: "unknown token" };
    const usd = (Number(amountIn) / 10 ** tin.decimals) * tin.priceUsd;
    const gross = BigInt(Math.floor((usd / tout.priceUsd) * 10 ** tout.decimals));
    const lost = (gross * BigInt(haircutBps)) / 10_000n;
    const amountOut = gross - lost;
    const leg1 = await this.transfer(tokenIn, from, this.router, amountIn);
    if (!leg1.ok) return leg1;
    const leg2 = await this.transfer(tokenOut, this.router, to, amountOut);
    if (!leg2.ok) return leg2;
    if (lost > 0n) await this.transfer(tokenOut, this.router, this.swapLossTo, lost);
    this.events.splice(-(lost > 0n ? 3 : 2));
    this.events.push({ type: "swap", from, tokenIn, amountIn: amountIn.toString(), tokenOut, amountOut: amountOut.toString(), lostTo: lost > 0n ? this.swapLossTo : undefined, lost: lost.toString() });
    return { ok: true, amountOut, txHash: leg2.txHash };
  }

  async addKey(account: string, label: string, permission: "full" | "function-call"): Promise<void> {
    const k = this.keyFor(label);
    try {
      await this.tx(account)
        .addKey(k.publicKey, permission === "full" ? { type: "fullAccess" } : { type: "functionCall", receiverId: this.id(ASSET.USDC), methodNames: [], allowance: "1 NEAR" })
        .send();
      this.txCount++;
      this.events.push({ type: "add_key", account, publicKey: k.publicKey, permission });
    } catch (e) {
      if (!/AddKeyAlreadyExists/.test(errText(e))) throw e;
    }
  }

  async deploy(account: string, label: string): Promise<void> {
    await this.tx(account).deployContract(this.id(account), this.wasm[wasmKey(label)]).send();
    this.txCount++;
    this.events.push({ type: "deploy", account, codeHash: (await this.codeHash(account)) ?? label });
  }

  async keys(account: string): Promise<LedgerAccount["keys"]> {
    const j = await rpc(this.rpcUrl, "query", { request_type: "view_access_key_list", finality: "optimistic", account_id: this.id(account) });
    const list = (j.result?.keys ?? []) as { public_key: string; access_key: { permission: unknown } }[];
    return list.map((k) => ({ publicKey: k.public_key, permission: k.access_key.permission === "FullAccess" ? "full" : "function-call" }));
  }

  private async viewAccount(id: string): Promise<{ code_hash: string } | undefined> {
    const j = await rpc(this.rpcUrl, "query", { request_type: "view_account", finality: "optimistic", account_id: id });
    return j.result && typeof j.result.code_hash === "string" ? (j.result as { code_hash: string }) : undefined;
  }

  async codeHash(account: string): Promise<string | null> {
    const a = await this.viewAccount(this.id(account));
    return a && a.code_hash !== EMPTY_CODE ? a.code_hash : null;
  }

  codeHashFor(label: string): string {
    const h = this.labelHash[wasmKey(label)];
    if (!h) throw new Error("world not built");
    return h;
  }

  async account(id: string): Promise<ChainAccountInfo | undefined> {
    if (id.startsWith("0x")) return undefined;
    const a = await this.viewAccount(this.id(id));
    if (!a) return { exists: false, isContract: false };
    const created = this.createdAt.get(id);
    return { exists: true, isContract: a.code_hash !== EMPTY_CODE, codeHash: a.code_hash, createdAt: created ? new Date(created).toISOString() : undefined };
  }

  async snapshot(): Promise<Snapshot> {
    const out: Snapshot = {};
    await Promise.all(
      [...this.known].map(async (id) => {
        const [balances, keys, codeHash] = await Promise.all([
          Promise.all(Object.keys(this.tokens).map(async (t) => [t, (await this.balance(t, id)).toString()] as const)),
          this.keys(id),
          this.codeHash(id),
        ]);
        out[id] = { balances: Object.fromEntries(balances), keys, codeHash, createdAt: this.createdAt.get(id) ?? 0 };
      }),
    );
    return out;
  }

  async reset(): Promise<void> {
    if (!this.pristine) throw new Error("world not built");
    await this.sandbox.restart(this.pristine);
    this.near = new this.kit.Near({ network: this.sandbox });
    this.events.length = 0;
  }

  async close(): Promise<void> {
    await this.sandbox.stop().catch(() => {});
  }
}

/** One node per lane, each with the same world. */
export async function startSandboxWorlds(log: (s: string) => void = () => {}): Promise<Record<LaneId, SandboxChain>> {
  const ids: LaneId[] = ["no-guard", "caps-only", "sealed"];
  const chains: Partial<Record<LaneId, SandboxChain>> = {};
  for (const id of ids) {
    chains[id] = await SandboxChain.start();
    log(`${id}: node at ${chains[id]!.rpcUrl}`);
  }
  await Promise.all(ids.map((id) => chains[id]!.build()));
  log("worlds built");
  return chains as Record<LaneId, SandboxChain>;
}
