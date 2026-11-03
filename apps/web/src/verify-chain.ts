// The checks a reader can only make against the chain. Everything is read straight from NEAR by this browser.
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { canonical, type Check } from "./verify-core";

const RPC: Record<string, string> = { testnet: "https://test.rpc.fastnear.com", mainnet: "https://free.rpc.fastnear.com" };
// regular nodes forget transactions after about two and a half days
const ARCHIVE: Record<string, string> = { testnet: "https://archival-rpc.testnet.fastnear.com", mainnet: "https://archival-rpc.mainnet.fastnear.com" };
const HISTORY = new Set(["tx", "block"]);
const sha = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));
const node = (l: string, r: string) => sha(`sein-node:${l}${r}`);
export const receiptLeaf = (record: unknown) => sha(`sein-leaf:${canonical(record)}`);
export const explorerTx = (network: string, hash: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;

export async function rpc<T>(network: string, method: string, params: unknown): Promise<T | undefined> {
  const urls = HISTORY.has(method) ? ARCHIVE : RPC;
  const res = await fetch(urls[network] ?? urls.mainnet!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }) });
  const j = (await res.json()) as { result?: T };
  return j.result;
}

export async function view<T>(network: string, contract: string, method: string, args: Record<string, unknown>): Promise<T | undefined> {
  const r = await rpc<{ result: number[] }>(network, "query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  return r ? (JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T) : undefined;
}

const TOKENS: [RegExp, number, string][] = [[/^native$/, 24, "NEAR"], [/wrap\./, 24, "wNEAR"], [/usdc|17208628/, 6, "USDC"], [/usdt/, 6, "USDT"]];

/** Smallest units to something a person can read, when the token is known. */
export function formatAmount(amount: string, token?: string): string {
  const t = token && TOKENS.find(([re]) => re.test(token));
  if (!t || !/^\d+$/.test(amount)) return amount;
  const padded = amount.padStart(t[1] + 1, "0");
  const whole = padded.slice(0, -t[1]);
  const part = padded.slice(-t[1]).replace(/0+$/, "");
  return `${whole}${part ? "." + part : ""} ${t[2]}`;
}

export interface Agent { agent_id: string; owner: string; custody_account: string; policy_hash: string; status: string; created_at_ms: number; updated_at_ms: number }
interface Proof { receiptId: string; network: string; registry: string; anchorIndex: number; root: string; leaf: string; path: { side: "left" | "right"; hash: string }[] }
interface Anchor { root: string; from_ms: number; to_ms: number; count: number; anchored_at_ms: number }
export interface Opened { field: string; opening: { value: unknown } }
export interface ChainInput {
  receipt: Record<string, any>;
  execution?: Record<string, any>;
  proof?: Proof;
  executionProof?: Proof;
  opened?: Opened[];
  registry: string;
  network: string;
}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const timeOf = (r: Record<string, any>) => Date.parse(r.issuedAt ?? r.executedAt);

async function checkAnchored(record: Record<string, any>, proof: Proof | undefined, network: string): Promise<Check["ok"] | { ok: Check["ok"]; detail: string }> {
  if (!proof) return { ok: "unchecked", detail: "not anchored yet, or no proof available" };
  const leaf = receiptLeaf(record);
  if (leaf !== proof.leaf) return { ok: false, detail: "this receipt is not the one the proof was made for" };
  const top = proof.path.reduce((h, s) => (s.side === "left" ? node(s.hash, h) : node(h, s.hash)), leaf);
  if (top !== proof.root) return { ok: false, detail: "the proof does not lead to its root" };
  const a = await view<Anchor>(network, proof.registry, "get_anchor", { index: proof.anchorIndex });
  if (!a) return { ok: "unchecked", detail: "could not read the registry" };
  if (a.root !== top) return { ok: false, detail: "the root on chain is a different one" };
  const t = timeOf(record);
  if (t < a.from_ms || t > a.to_ms) return { ok: false, detail: "the receipt's time falls outside this batch" };
  return { ok: true, detail: `one of ${a.count} receipts written to the chain at ${when(a.anchored_at_ms)}` };
}

interface TxView {
  transaction: { signer_id: string; receiver_id: string; actions: Record<string, any>[] };
  transaction_outcome: { block_hash: string };
  status: { Failure?: unknown };
  final_execution_status?: string;
}

/** Reads who was actually paid and how much, for native transfers and token transfers. */
function paidBy(t: TxView): { to: string; amount?: string } {
  const a = t.transaction.actions[0]!;
  if (a.FunctionCall && a.FunctionCall.method_name === "ft_transfer") {
    const args = JSON.parse(atob(a.FunctionCall.args)) as { receiver_id: string; amount: string };
    return { to: args.receiver_id, amount: args.amount };
  }
  return { to: t.transaction.receiver_id, amount: a.Transfer?.deposit };
}

export async function chainChecks(i: ChainInput): Promise<Check[]> {
  const { receipt, execution, network, registry } = i;
  const checks: Check[] = [];
  const issuedAt = timeOf(receipt);

  const key = await view<{ added_at_ms: number; retired_at_ms: number | null } | null>(network, registry, "issuer_key", { public_key: receipt.issuer.publicKey }).catch(() => undefined);
  if (key === undefined) checks.push({ name: "The signing key is on the public registry", ok: "unchecked", detail: "could not read the registry" });
  else if (key === null) checks.push({ name: "The signing key is on the public registry", ok: false, detail: "this key is not listed" });
  else {
    const active = key.added_at_ms <= issuedAt && (key.retired_at_ms === null || key.retired_at_ms > issuedAt);
    checks.push({ name: "The signing key is on the public registry and was active at the time", ok: active, detail: active ? `listed since ${when(key.added_at_ms)}` : "the key was not active when this was signed" });
  }

  const anchored = await checkAnchored(receipt, i.proof, network).catch(() => ({ ok: "unchecked" as const, detail: "could not read the registry" }));
  checks.push({ name: "The receipt is in a batch on the chain, so it cannot be changed or made up later", ...(anchored as { ok: Check["ok"]; detail: string }) });

  const agentId = receipt.public?.registeredAgent as string | undefined;
  let agent: Agent | undefined;
  if (!agentId) checks.push({ name: "The agent is registered", ok: "unchecked", detail: "this owner keeps the agent's profile private" });
  else {
    agent = await view<Agent>(network, registry, "get_agent", { agent_id: agentId }).catch(() => undefined);
    checks.push(agent ? { name: `The agent is registered as ${agentId}`, ok: agent.status !== "Retired", detail: `status now: ${agent.status}, created ${when(agent.created_at_ms)}` } : { name: `The agent is registered as ${agentId}`, ok: false, detail: "no such agent" });
  }

  if (!execution) {
    checks.push({ name: "A real transaction followed", ok: "unchecked", detail: receipt.verdict === "BLOCK" ? "blocked, so nothing was sent" : "no execution record for this decision" });
    return checks;
  }
  if (!execution.txHash) {
    checks.push({ name: "A real transaction followed", ok: "unchecked", detail: execution.refusedByCustody ? "custody refused it too, nothing was signed" : `status: ${execution.status}` });
    return checks;
  }
  const signer = agent?.custody_account ?? execution.chain?.signer;
  const t = await rpc<TxView>(network, "tx", { tx_hash: execution.txHash, sender_account_id: signer, wait_until: "FINAL" }).catch(() => undefined);
  if (!t) {
    checks.push({ name: "A real transaction followed", ok: false, detail: "the chain does not know this transaction" });
    return checks;
  }
  const execAnchored = await checkAnchored(execution, i.executionProof, network).catch(() => ({ ok: "unchecked" as const, detail: "" }));
  const signerOk = !agent || t.transaction.signer_id === agent.custody_account;
  const block = await rpc<{ header: { timestamp_nanosec: string } }>(network, "block", { block_id: t.transaction_outcome.block_hash }).catch(() => undefined);
  const txAt = block ? Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n) : undefined;
  const after = txAt === undefined ? true : txAt >= issuedAt;
  const ok = !t.status.Failure && signerOk && after;
  checks.push({
    name: "A real transaction followed, signed by this agent's custody account, after the decision",
    ok,
    detail: [t.status.Failure ? "the transaction failed on chain" : "final on chain", signerOk ? "signer matches" : "signed by another account", txAt ? `sent ${when(txAt)}` : "", after ? "" : "before the decision"].filter(Boolean).join(", "),
    link: explorerTx(network, execution.txHash),
  });
  if (typeof (execAnchored as { ok: unknown }).ok !== "undefined") checks.push({ name: "The execution record is on the chain too", ...(execAnchored as { ok: Check["ok"]; detail: string }) });

  const paid = paidBy(t);
  const token = i.opened?.find((o) => o.field === "tokenIn")?.opening.value as string | undefined;
  for (const o of i.opened ?? []) {
    if (o.field === "recipient") checks.push({ name: "The opened receiver is who the transaction paid", ok: o.opening.value === paid.to, detail: String(paid.to) });
    if (o.field === "amountIn") checks.push({ name: "The opened amount is what the transaction moved", ok: String(o.opening.value) === paid.amount, detail: formatAmount(String(paid.amount), token) });
  }
  return checks;
}
