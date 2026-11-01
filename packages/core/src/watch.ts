import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "./sqlite";

/**
 * Watches the agent's on-chain account from the outside. A checker in front of the wallet
 * cannot see a key that was added some other way, so this compares the account with what the
 * owner last accepted. An unknown key or a code change freezes the wallet.
 */
export interface AccountState {
  keys: string[];
  codeHash: string | null;
}

export interface AccountStateReader {
  state(account: string): Promise<AccountState | undefined>;
}

const EMPTY_CODE = "11111111111111111111111111111111";

export class RpcAccountStateReader implements AccountStateReader {
  private readonly urls: string[];

  constructor(urls?: string[], private readonly fetchImpl: typeof fetch = fetch) {
    const env = process.env.NEAR_RPC_URLS ?? process.env.NEAR_RPC_URL;
    this.urls = urls ?? (env ? env.split(",").map((s) => s.trim()).filter(Boolean) : ["https://rpc.mainnet.near.org", "https://free.rpc.fastnear.com"]);
  }

  private async query(url: string, request_type: string, account_id: string): Promise<Record<string, unknown> | undefined> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "watch", method: "query", params: { request_type, finality: "final", account_id } }),
    });
    return ((await res.json()) as { result?: Record<string, unknown> }).result;
  }

  async state(account: string): Promise<AccountState | undefined> {
    for (const url of this.urls) {
      try {
        const [keys, view] = await Promise.all([this.query(url, "view_access_key_list", account), this.query(url, "view_account", account)]);
        if (!keys || !view) continue;
        const code = view.code_hash as string;
        return { keys: (keys.keys as { public_key: string }[]).map((k) => k.public_key).sort(), codeHash: code === EMPTY_CODE ? null : code };
      } catch {
        /* try the next endpoint */
      }
    }
    return undefined;
  }
}

export interface WatchFinding {
  account: string;
  newKeys: string[];
  codeChanged: boolean;
}

export type WatchResult = { account: string; status: "baseline" | "ok" | "unavailable" } | ({ status: "changed" } & WatchFinding);

export class AccountWatcher {
  private db: DatabaseSync;

  constructor(
    path: string,
    private readonly opts: {
      accounts: string[];
      reader: AccountStateReader;
      /** called once per finding; the wallet must end up frozen */
      onChange: (finding: WatchFinding) => void | Promise<void>;
    },
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec("CREATE TABLE IF NOT EXISTS watch_baseline (account TEXT PRIMARY KEY, state TEXT NOT NULL, seen_at INTEGER NOT NULL);");
  }

  private baseline(account: string): AccountState | undefined {
    const row = this.db.prepare("SELECT state FROM watch_baseline WHERE account=?").get(account) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as AccountState) : undefined;
  }

  private store(account: string, state: AccountState, now = Date.now()): void {
    this.db.prepare("INSERT INTO watch_baseline VALUES (?,?,?) ON CONFLICT(account) DO UPDATE SET state=excluded.state, seen_at=excluded.seen_at").run(account, JSON.stringify(state), now);
  }

  /** One round. The first sighting of an account becomes its baseline. */
  async tick(): Promise<WatchResult[]> {
    const out: WatchResult[] = [];
    for (const account of this.opts.accounts) {
      const state = await this.opts.reader.state(account).catch(() => undefined);
      if (!state) {
        out.push({ account, status: "unavailable" });
        continue;
      }
      const known = this.baseline(account);
      if (!known) {
        this.store(account, state);
        out.push({ account, status: "baseline" });
        continue;
      }
      const newKeys = state.keys.filter((k) => !known.keys.includes(k));
      const codeChanged = state.codeHash !== known.codeHash;
      if (newKeys.length === 0 && !codeChanged) {
        out.push({ account, status: "ok" });
        continue;
      }
      const finding: WatchFinding = { account, newKeys, codeChanged };
      await this.opts.onChange(finding);
      out.push({ status: "changed", ...finding });
    }
    return out;
  }

  /** The owner looked and accepts what is on chain now. */
  async accept(account: string): Promise<boolean> {
    const state = await this.opts.reader.state(account).catch(() => undefined);
    if (!state) return false;
    this.store(account, state);
    return true;
  }

  close(): void {
    this.db.close();
  }
}
