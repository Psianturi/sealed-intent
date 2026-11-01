import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, signBytes, verifyBytes, type IssuerKey, type Vault } from "@sealed-intent/receipt";
import type { Policy } from "./policy";
import { DatabaseSync } from "./sqlite";

/**
 * Counterparty check: who is about to receive the money?
 *
 * Signals (data source in brackets):
 *  - shared blocklist with evidence           [blocklist file / other agents' reports, each signed]
 *  - account exists, is a contract, code hash [NEAR RPC view_account]
 *  - contract code changed since last seen    [local memory of code hashes]
 *  - account age                              [indexer such as FastNEAR / NearBlocks; fixture offline]
 *  - prior interactions agent -> receiver     [local memory of executed payments]
 */

// ---------- shared blocklist ----------

export interface BlocklistEntry {
  account: string;
  reason: string;
  evidence: string[];
  reportedBy: string;
  reportedAt: string;
  /** ed25519 public key of the Sealed Intent instance that accepted the report */
  signer?: string;
  signature?: string;
  /** false until the owner confirms an agent's report; absent on owner-curated entries */
  confirmed?: boolean;
}

export class SharedBlocklist {
  private entries: BlocklistEntry[];

  constructor(private readonly path: string, private readonly issuer?: IssuerKey) {
    this.entries = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BlocklistEntry[]) : [];
  }

  find(account: string): BlocklistEntry | undefined {
    return this.entries.find((e) => e.account.toLowerCase() === account.toLowerCase());
  }

  all(): BlocklistEntry[] {
    return [...this.entries];
  }

  /** Another agent reports a bad counterparty. Evidence is required; the entry only warns until the owner confirms it. */
  report(input: Omit<BlocklistEntry, "reportedAt" | "signer" | "signature">): BlocklistEntry {
    if (!input.evidence.length) throw new Error("a report needs at least one piece of evidence (tx hash, receipt id, URL)");
    const unsigned: BlocklistEntry = { ...input, confirmed: input.confirmed ?? false, account: input.account.toLowerCase(), reportedAt: new Date().toISOString() };
    const entry = this.issuer
      ? { ...unsigned, signer: this.issuer.publicKeyHex, signature: signBytes(this.issuer, canonicalJson(unsigned)) }
      : unsigned;
    this.entries = [...this.entries.filter((e) => e.account !== entry.account), entry];
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries, null, 2));
    return entry;
  }

  /** The owner confirms an agent's report: from then on it blocks. */
  confirm(account: string): BlocklistEntry | undefined {
    const e = this.find(account);
    if (!e) return undefined;
    const confirmed = { ...e, confirmed: true };
    this.entries = this.entries.map((x) => (x === e ? confirmed : x));
    writeFileSync(this.path, JSON.stringify(this.entries, null, 2));
    return confirmed;
  }

  static verifyEntry(e: BlocklistEntry): boolean {
    if (!e.signer || !e.signature) return false;
    const { signer: _s, signature, ...unsigned } = e;
    return verifyBytes(e.signer, canonicalJson(unsigned), signature);
  }
}

// ---------- chain data ----------

export interface ChainAccountInfo {
  exists: boolean;
  isContract: boolean;
  codeHash?: string;
  /** ISO time the account was created, when an indexer is available */
  createdAt?: string;
  /** two RPC sources answered differently */
  disagreement?: boolean;
}

export interface ChainReader {
  account(id: string): Promise<ChainAccountInfo | undefined>;
}

const EMPTY_CODE = "11111111111111111111111111111111";

const DEFAULT_RPCS = ["https://rpc.mainnet.near.org", "https://free.rpc.fastnear.com"];

/**
 * NEAR RPC view_account, asked of every configured endpoint (NEAR_RPC_URLS, comma separated).
 * One lying endpoint cannot hide a code change: any disagreement is reported. Account age
 * is not available from RPC (needs an indexer).
 */
export class RpcChainReader implements ChainReader {
  private readonly urls: string[];
  constructor(urls?: string | string[], private readonly fetchImpl: typeof fetch = fetch) {
    const env = process.env.NEAR_RPC_URLS ?? process.env.NEAR_RPC_URL;
    this.urls = typeof urls === "string" ? [urls] : (urls ?? (env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_RPCS));
  }

  private async one(url: string, id: string): Promise<ChainAccountInfo | undefined> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "sealed", method: "query", params: { request_type: "view_account", finality: "final", account_id: id } }),
    });
    const json = (await res.json()) as { result?: { code_hash: string }; error?: { cause?: { name?: string } } };
    if (json.error?.cause?.name === "UNKNOWN_ACCOUNT") return { exists: false, isContract: false };
    if (!json.result) return undefined;
    return { exists: true, isContract: json.result.code_hash !== EMPTY_CODE, codeHash: json.result.code_hash };
  }

  async account(id: string): Promise<ChainAccountInfo | undefined> {
    if (id.startsWith("0x")) return undefined; // not a NEAR account
    const answers = (await Promise.allSettled(this.urls.map((u) => this.one(u, id)))).flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
    const first = answers[0];
    if (!first) return undefined;
    const disagreement = answers.some((a) => a.exists !== first.exists || a.codeHash !== first.codeHash);
    return disagreement ? { ...first, disagreement } : first;
  }
}

export class FixtureChainReader implements ChainReader {
  constructor(private readonly accounts: Record<string, ChainAccountInfo>) {}
  async account(id: string): Promise<ChainAccountInfo | undefined> {
    return this.accounts[id] ?? { exists: false, isContract: false };
  }
}

// ---------- local memory ----------

export class CounterpartyMemory {
  private db: DatabaseSync;
  private readonly key: (s: string) => string;

  /** With a vault, the database holds keyed hashes instead of who paid whom. */
  constructor(path: string, vault?: Vault) {
    this.key = (s) => (vault ? vault.blind(s.toLowerCase()) : s.toLowerCase());
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interactions (agent_id TEXT, counterparty TEXT, n INTEGER, last_at INTEGER, PRIMARY KEY (agent_id, counterparty));
      CREATE TABLE IF NOT EXISTS code_hashes (account TEXT PRIMARY KEY, code_hash TEXT, seen_at INTEGER);
    `);
  }

  interactions(agentId: string, counterparty: string): number {
    const row = this.db.prepare("SELECT n FROM interactions WHERE agent_id=? AND counterparty=?").get(this.key(agentId), this.key(counterparty)) as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  recordInteraction(agentId: string, counterparty: string, now = Date.now()): void {
    this.db
      .prepare("INSERT INTO interactions VALUES (?,?,1,?) ON CONFLICT(agent_id, counterparty) DO UPDATE SET n = n + 1, last_at = excluded.last_at")
      .run(this.key(agentId), this.key(counterparty), now);
  }

  /** Returns the code hash on record and stores this one only if none was recorded. A change stays visible until the owner accepts it. */
  observeCodeHash(account: string, codeHash: string, now = Date.now()): string | undefined {
    const id = this.key(account);
    const prev = this.db.prepare("SELECT code_hash FROM code_hashes WHERE account=?").get(id) as { code_hash: string } | undefined;
    if (!prev) this.db.prepare("INSERT INTO code_hashes VALUES (?,?,?)").run(id, codeHash, now);
    return prev?.code_hash;
  }

  /** The owner accepts the contract's current code. */
  acceptCodeHash(account: string, codeHash: string, now = Date.now()): void {
    this.db.prepare("INSERT INTO code_hashes VALUES (?,?,?) ON CONFLICT(account) DO UPDATE SET code_hash=excluded.code_hash, seen_at=excluded.seen_at").run(this.key(account), codeHash, now);
  }

  close(): void {
    this.db.close();
  }
}

// ---------- assessment ----------

export interface CounterpartyDeps {
  blocklist: SharedBlocklist;
  chain: ChainReader;
  memory: CounterpartyMemory;
}

export interface CounterpartyAssessment {
  block: string[];
  review: string[];
  signals: Record<string, unknown>;
}

export async function assessCounterparty(
  args: { agentId: string; account: string; policy: Policy; now?: number },
  deps: CounterpartyDeps,
): Promise<CounterpartyAssessment> {
  const { agentId, account, policy } = args;
  const now = args.now ?? Date.now();
  const block: string[] = [];
  const review: string[] = [];
  const signals: Record<string, unknown> = {};

  const listed = deps.blocklist.find(account);
  if (listed) {
    // an agent's unconfirmed report asks a human; an owner-confirmed entry blocks
    (listed.confirmed === false ? review : block).push(listed.confirmed === false ? "COUNTERPARTY_REPORTED" : "COUNTERPARTY_BLOCKLISTED");
    signals.blocklist = { reason: listed.reason, evidence: listed.evidence.length, confirmed: listed.confirmed !== false };
  }

  let info: ChainAccountInfo | undefined;
  try {
    info = await deps.chain.account(account);
  } catch {
    review.push("COUNTERPARTY_LOOKUP_FAILED");
  }
  if (info) {
    signals.chain = info;
    if (info.disagreement) review.push("RPC_DISAGREEMENT");
    // a code change is checked for every contract, allow-listed or not
    if (info.isContract && info.codeHash) {
      const prev = deps.memory.observeCodeHash(account, info.codeHash, now);
      if (prev && prev !== info.codeHash) review.push("COUNTERPARTY_CODE_CHANGED");
    }
  }
  if (policy.allowedRecipients.includes(account)) {
    signals.allowListed = true;
    return { block, review, signals };
  }

  // Not on the owner's allow-list: look closer, then block or ask a human.
  (policy.unknownRecipient === "block" ? block : review).push("RECIPIENT_NOT_ALLOWLISTED");
  if (info) {
    const implicit = /^[0-9a-f]{64}$/.test(account);
    if (!info.exists && !implicit) block.push("COUNTERPARTY_NOT_FOUND");
    if (info.createdAt) {
      const ageDays = (now - Date.parse(info.createdAt)) / 86_400_000;
      signals.ageDays = Math.floor(ageDays);
      if (ageDays < policy.minAccountAgeDays) review.push("COUNTERPARTY_NEW_ACCOUNT");
    }
  }
  const prior = deps.memory.interactions(agentId, account);
  signals.priorInteractions = prior;
  if (prior === 0) review.push("COUNTERPARTY_FIRST_CONTACT");

  return { block, review, signals };
}
