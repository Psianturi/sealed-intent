import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "./sqlite";

/**
 * Every transaction the custody account signs must trace back to a SeIn decision. This catches
 * the shortcut no checker in front of the wallet can see: a request sent straight to custody with
 * a stolen key, or a breached SeIn server. Sources are compared with what SeIn recorded itself:
 * an indexer, the custody log, and the key nonce, which only the chain controls.
 */
export interface OutgoingSource {
  readonly name: string;
  /** hashes of transactions this account signed, newest first; throws when unavailable */
  list(account: string): Promise<string[]>;
}

/** Number of transactions the account's keys have signed so far, read from the chain. */
export interface NonceReader {
  nonce(account: string): Promise<bigint | undefined>;
}

export interface ReconcileFinding {
  account: string;
  unknownTx: string[];
  /** transactions the nonce counted beyond what SeIn recorded; catches what the logs do not list */
  uncountedByNonce: number;
  sources: string[];
}

export type ReconcileResult = { status: "baseline" | "ok" | "deferred" | "unavailable"; detail?: string } | ({ status: "mismatch" } & ReconcileFinding);

/** Beyond this an in-flight payment no longer excuses an unknown transaction. */
const IN_FLIGHT_GRACE_MS = 3 * 60_000;

export class Reconciler {
  private db: DatabaseSync;

  constructor(
    path: string,
    private readonly opts: {
      account: string;
      sources: OutgoingSource[];
      nonce?: NonceReader;
      /** called on a mismatch; the wallet must end up frozen */
      onMismatch: (finding: ReconcileFinding) => void | Promise<void>;
    },
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS known_tx (hash TEXT PRIMARY KEY, decision_id TEXT, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS in_flight (decision_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reconcile_base (id INTEGER PRIMARY KEY CHECK (id = 1), nonce TEXT, known_at_base INTEGER NOT NULL);
    `);
  }

  /** Before a payment is sent. A transaction that appears meanwhile is not treated as unknown yet. */
  begin(decisionId: string, now = Date.now()): void {
    this.db.prepare("INSERT OR REPLACE INTO in_flight VALUES (?,?)").run(decisionId, now);
  }

  /** After a payment: these hashes belong to this decision. */
  end(decisionId: string, hashes: string[], now = Date.now()): void {
    const add = this.db.prepare("INSERT OR IGNORE INTO known_tx VALUES (?,?,?)");
    for (const h of hashes) add.run(h, decisionId, now);
    this.db.prepare("DELETE FROM in_flight WHERE decision_id=?").run(decisionId);
  }

  private knownCount(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM known_tx").get() as { n: number }).n);
  }

  private isKnown(hash: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM known_tx WHERE hash=?").get(hash);
  }

  private inFlight(now: number): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM in_flight WHERE at > ?").get(now - IN_FLIGHT_GRACE_MS) as { n: number }).n);
  }

  private async gather(): Promise<{ hashes: string[]; answered: string[]; failed: string[] }> {
    const { account } = this.opts;
    const hashes = new Set<string>();
    const answered: string[] = [];
    const failed: string[] = [];
    await Promise.all(
      this.opts.sources.map(async (s) => {
        try {
          for (const h of await s.list(account)) hashes.add(h);
          answered.push(s.name);
        } catch {
          failed.push(s.name);
        }
      }),
    );
    return { hashes: [...hashes], answered, failed };
  }

  private setBase(nonce: bigint | undefined, hashes: string[], now: number): void {
    const add = this.db.prepare("INSERT OR IGNORE INTO known_tx VALUES (?,?,?)");
    for (const h of hashes) add.run(h, "accepted", now);
    this.db.prepare("INSERT INTO reconcile_base VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET nonce=excluded.nonce, known_at_base=excluded.known_at_base").run(nonce?.toString() ?? null, this.knownCount());
  }

  /** One round. The first run accepts the account's history as the starting point. */
  async tick(now = Date.now()): Promise<ReconcileResult> {
    const { account } = this.opts;
    const nonce = await this.opts.nonce?.nonce(account).catch(() => undefined);
    const { hashes, answered, failed } = await this.gather();
    const base = this.db.prepare("SELECT nonce, known_at_base FROM reconcile_base WHERE id=1").get() as { nonce: string | null; known_at_base: number } | undefined;
    // nothing at all to compare with: never read silence as "all clear"
    if (answered.length === 0 && nonce === undefined) return { status: "unavailable", detail: `no source answered (${failed.join(", ")})` };
    if (!base) {
      this.setBase(nonce, hashes, now);
      return { status: "baseline" };
    }
    const unknownTx = hashes.filter((h) => !this.isKnown(h));
    const signedSince = nonce !== undefined && base.nonce !== null ? nonce - BigInt(base.nonce) : 0n;
    const recordedSince = BigInt(this.knownCount() - Number(base.known_at_base));
    const uncounted = signedSince > recordedSince ? Number(signedSince - recordedSince) : 0;
    if (unknownTx.length === 0 && uncounted === 0) return { status: "ok", detail: failed.length ? `no answer from ${failed.join(", ")}` : undefined };
    if (this.inFlight(now) > 0) return { status: "deferred", detail: "a payment is being sent" };
    const finding: ReconcileFinding = { account, unknownTx, uncountedByNonce: uncounted, sources: answered };
    await this.opts.onMismatch(finding);
    return { status: "mismatch", ...finding };
  }

  /** The owner looked at it and accepts the history as it is now. */
  async accept(now = Date.now()): Promise<boolean> {
    const { hashes, answered } = await this.gather();
    if (answered.length === 0) return false;
    this.setBase(await this.opts.nonce?.nonce(this.opts.account).catch(() => undefined), hashes, now);
    return true;
  }

  close(): void {
    this.db.close();
  }
}

/** FastNEAR transaction index: tx.main.fastnear.com or tx.test.fastnear.com. */
export class FastNearTxSource implements OutgoingSource {
  readonly name = "indexer";
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async list(account: string): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v0/account`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account_id: account, is_signer: true, limit: 200 }) });
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
    const j = (await res.json()) as { account_txs?: { transaction_hash: string; is_signer?: boolean }[] };
    if (!j.account_txs) throw new Error("indexer gave no list");
    return j.account_txs.filter((t) => t.is_signer !== false).map((t) => t.transaction_hash);
  }
}

/** What the custody service says it signed. It can only add to the picture, the chain has the last word. */
export class CustodyLogSource implements OutgoingSource {
  readonly name = "custody-log";
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async list(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/wallet/v1/audit?limit=100`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (!res.ok) throw new Error(`custody log HTTP ${res.status}`);
    const j = (await res.json()) as { events?: { tx_hash?: string | null }[] };
    if (!j.events) throw new Error("custody log gave no list");
    return j.events.flatMap((e) => (typeof e.tx_hash === "string" ? [e.tx_hash] : []));
  }
}

/** Sums the nonces of the account's access keys. */
export class RpcNonceReader implements NonceReader {
  constructor(private readonly rpcUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async nonce(account: string): Promise<bigint | undefined> {
    const res = await this.fetchImpl(this.rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "reconcile", method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: account } }) });
    const j = (await res.json()) as { result?: { keys?: { access_key: { nonce: number | string } }[] } };
    if (!j.result?.keys) return undefined;
    return j.result.keys.reduce((n, k) => n + BigInt(k.access_key.nonce), 0n);
  }
}
