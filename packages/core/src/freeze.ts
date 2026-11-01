import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "./sqlite";

/**
 * Wallet freeze that survives restarts. Set automatically on a forbidden action class
 * or a burst of BLOCKs, and only the owner can lift it.
 */
export interface FreezeState {
  frozen: boolean;
  reason?: string;
  by?: string;
  at?: number;
}

const HOUR = 3_600_000;

export class FreezeStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS freeze (scope TEXT PRIMARY KEY, reason TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS block_log (agent_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'block');
      CREATE INDEX IF NOT EXISTS idx_block_log ON block_log(agent_id, at);
    `);
    try {
      this.db.exec("ALTER TABLE block_log ADD COLUMN kind TEXT NOT NULL DEFAULT 'block'");
    } catch {
      /* column exists */
    }
  }

  state(): FreezeState {
    const row = this.db.prepare("SELECT reason, by, at FROM freeze WHERE scope='wallet'").get() as { reason: string; by: string; at: number } | undefined;
    return row ? { frozen: true, reason: row.reason, by: row.by, at: Number(row.at) } : { frozen: false };
  }

  freeze(reason: string, by: string, now = Date.now()): void {
    this.db.prepare("INSERT OR REPLACE INTO freeze (scope, reason, by, at) VALUES ('wallet', ?, ?, ?)").run(reason, by, now);
  }

  unfreeze(): boolean {
    return Number(this.db.prepare("DELETE FROM freeze WHERE scope='wallet'").run().changes) === 1;
  }

  /** Records a BLOCK and returns this agent's counts for the last hour. "limit" marks a block caused only by a cap. */
  recordBlock(agentId: string, kind: "block" | "limit" = "block", now = Date.now()): { blocks: number; limitProbes: number } {
    this.db.prepare("INSERT INTO block_log (agent_id, at, kind) VALUES (?, ?, ?)").run(agentId, now, kind);
    this.db.prepare("DELETE FROM block_log WHERE at < ?").run(now - 24 * HOUR);
    const all = this.db.prepare("SELECT COUNT(*) AS n FROM block_log WHERE agent_id=? AND at >= ?").get(agentId, now - HOUR) as { n: number };
    const limit = this.db.prepare("SELECT COUNT(*) AS n FROM block_log WHERE agent_id=? AND at >= ? AND kind='limit'").get(agentId, now - HOUR) as { n: number };
    return { blocks: Number(all.n), limitProbes: Number(limit.n) };
  }

  close(): void {
    this.db.close();
  }
}
