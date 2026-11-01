import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { merkleProof, merkleRoot, receiptLeaf, type ReceiptProof } from "@sealed-intent/receipt";

export interface AnchorRecord {
  index: number;
  root: string;
  from_ms: number;
  to_ms: number;
  count: number;
  anchored_at_ms: number;
}

/** The part of the registry contract the anchorer needs. */
export interface AnchorChain {
  readonly contract: string;
  readonly network: string;
  latestAnchor(): Promise<AnchorRecord | undefined>;
  anchor(root: string, fromMs: number, toMs: number, count: number): Promise<{ index: number; txHash: string }>;
}

const timeOf = (r: { issuedAt?: string; executedAt?: string }) => Date.parse(r.issuedAt ?? r.executedAt ?? "");

export interface AnchorResult {
  anchored: boolean;
  index?: number;
  count?: number;
  root?: string;
  txHash?: string;
}

/**
 * Writes the root of every receipt since the last anchor to the registry and stores one proof per
 * receipt. Very recent receipts wait for the next round, so one being written cannot straddle two periods.
 */
export class Anchorer {
  constructor(
    private readonly chain: AnchorChain,
    private readonly outDir = "out",
    private readonly settleMs = 5_000,
  ) {}

  private receipts(): { id: string; record: Record<string, unknown>; at: number }[] {
    const dir = join(this.outDir, "receipts");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          const record = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
          const at = timeOf(record);
          return record.receiptId && Number.isFinite(at) ? [{ id: String(record.receiptId), record, at }] : [];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }

  async tick(now = Date.now()): Promise<AnchorResult> {
    const last = await this.chain.latestAnchor();
    const batch = this.receipts().filter((r) => r.at <= now - this.settleMs && (!last || r.at > last.to_ms));
    if (batch.length === 0) return { anchored: false };
    const leaves = batch.map((r) => receiptLeaf(r.record));
    const root = merkleRoot(leaves);
    const { index, txHash } = await this.chain.anchor(root, batch[0]!.at, batch[batch.length - 1]!.at, batch.length);
    mkdirSync(join(this.outDir, "proofs"), { recursive: true });
    batch.forEach((r, i) => {
      const proof: ReceiptProof = { version: "sein/proof@1", receiptId: r.id, network: this.chain.network, registry: this.chain.contract, anchorIndex: index, anchorTx: txHash, root, leaf: leaves[i]!, path: merkleProof(leaves, i) };
      writeFileSync(join(this.outDir, "proofs", `${r.id}.json`), JSON.stringify(proof, null, 2));
    });
    return { anchored: true, index, count: batch.length, root, txHash };
  }
}

/** Reads and writes the sein-registry contract. */
export class RegistryClient implements AnchorChain {
  constructor(
    readonly contract: string,
    readonly network: string,
    private readonly rpcUrl: string,
    private readonly operator?: { account: string; key: string },
  ) {}

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "registry", method: "query", params: { request_type: "call_function", finality: "final", account_id: this.contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
    });
    const j = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: unknown };
    if (!j.result?.result) throw new Error(`registry ${method}: ${JSON.stringify(j.error ?? j.result?.error).slice(0, 200)}`);
    return JSON.parse(Buffer.from(j.result.result).toString("utf8")) as T;
  }

  async latestAnchor(): Promise<AnchorRecord | undefined> {
    const count = await this.view<number>("anchor_count");
    return count === 0 ? undefined : ((await this.view<AnchorRecord | null>("get_anchor", { index: count - 1 })) ?? undefined);
  }

  async anchor(root: string, fromMs: number, toMs: number, count: number): Promise<{ index: number; txHash: string }> {
    if (!this.operator) throw new Error("no operator key configured");
    const { Near } = await import("near-kit");
    const near = new Near({ network: { networkId: this.network, rpcUrl: this.rpcUrl }, privateKey: this.operator.key as `ed25519:${string}`, defaultSignerId: this.operator.account });
    const tx = await near.transaction(this.operator.account).functionCall(this.contract, "anchor", { root, from_ms: fromMs, to_ms: toMs, count }, { gas: "30 Tgas" }).send();
    const returned = (tx.status as { SuccessValue?: string }).SuccessValue;
    if (returned === undefined) throw new Error(`anchor tx ${tx.transaction.hash} gave no index`);
    return { index: JSON.parse(Buffer.from(returned, "base64").toString("utf8")) as number, txHash: tx.transaction.hash };
  }
}

export function registryFromEnv(env: NodeJS.ProcessEnv = process.env): RegistryClient | undefined {
  const contract = env.SEIN_REGISTRY_ACCOUNT;
  if (!contract) return undefined;
  const testnet = env.SEALED_NETWORK === "testnet";
  const operator = env.SEIN_OPERATOR_ACCOUNT && env.SEIN_OPERATOR_KEY ? { account: env.SEIN_OPERATOR_ACCOUNT, key: env.SEIN_OPERATOR_KEY } : undefined;
  return new RegistryClient(contract, testnet ? "testnet" : "mainnet", env.NEAR_RPC_URL ?? (testnet ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com"), operator);
}
