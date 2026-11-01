import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "./sqlite";

/**
 * Atomic spending budget.
 *
 * The problem it fixes: OutLayer's own docs say hourly/daily caps are checked
 * against a counter, so concurrent requests can all read the same counter, all
 * pass, and together exceed the cap. Here every reservation runs inside a SQLite
 * `BEGIN IMMEDIATE` transaction, which takes the database write lock before
 * reading the totals. Requests are serialized across threads AND processes, so
 * the sum of reserved + committed spend stays within the limit for one agent name.
 *
 * Lifecycle: reserve -> commit (executed) | release (blocked / failed / expired).
 */
export interface BudgetLimits {
  hourlyCents: number;
  dailyCents: number;
  /** how many spends (any amount) the agent may start per hour */
  maxPerHour?: number;
}

export type ReserveResult =
  | { ok: true; reservationId: string; hourUsedCents: number; dayUsedCents: number }
  | { ok: false; reason: "HOURLY_BUDGET_EXCEEDED" | "DAILY_BUDGET_EXCEEDED" | "TX_RATE_EXCEEDED" };

const HOUR = 3_600_000;
const DAY = 86_400_000;

export class BudgetLedger {
  private db: DatabaseSync;

  constructor(path: string, private readonly reservationTtlMs = 10 * 60_000) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        usd_cents INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','committed','released')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_res_agent_time ON reservations(agent_id, created_at);
    `);
  }

  reserve(agentId: string, usdCents: number, limits: BudgetLimits, now = Date.now()): ReserveResult {
    if (!Number.isInteger(usdCents) || usdCents < 0) throw new Error("usdCents must be a non-negative integer");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE reservations SET status='released' WHERE status='reserved' AND expires_at < ?").run(now);
      const sum = this.db.prepare(
        "SELECT COALESCE(SUM(usd_cents),0) AS s FROM reservations WHERE agent_id=? AND status IN ('reserved','committed') AND created_at >= ?",
      );
      const hour = Number((sum.get(agentId, now - HOUR) as { s: number }).s);
      const day = Number((sum.get(agentId, now - DAY) as { s: number }).s);
      if (hour + usdCents > limits.hourlyCents) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "HOURLY_BUDGET_EXCEEDED" };
      }
      if (day + usdCents > limits.dailyCents) {
        this.db.exec("ROLLBACK");
        return { ok: false, reason: "DAILY_BUDGET_EXCEEDED" };
      }
      if (limits.maxPerHour !== undefined) {
        const n = Number((this.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE agent_id=? AND status IN ('reserved','committed') AND created_at >= ?").get(agentId, now - HOUR) as { n: number }).n);
        if (n + 1 > limits.maxPerHour) {
          this.db.exec("ROLLBACK");
          return { ok: false, reason: "TX_RATE_EXCEEDED" };
        }
      }
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO reservations (id, agent_id, usd_cents, status, created_at, expires_at) VALUES (?,?,?,?,?,?)")
        .run(id, agentId, usdCents, "reserved", now, now + this.reservationTtlMs);
      this.db.exec("COMMIT");
      return { ok: true, reservationId: id, hourUsedCents: hour + usdCents, dayUsedCents: day + usdCents };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  commit(reservationId: string): boolean {
    return Number(this.db.prepare("UPDATE reservations SET status='committed' WHERE id=? AND status='reserved'").run(reservationId).changes) === 1;
  }

  /** Execution failed after commit: give the budget back. */
  uncommit(reservationId: string): boolean {
    return Number(this.db.prepare("UPDATE reservations SET status='released' WHERE id=? AND status='committed'").run(reservationId).changes) === 1;
  }

  release(reservationId: string): boolean {
    return Number(this.db.prepare("UPDATE reservations SET status='released' WHERE id=? AND status='reserved'").run(reservationId).changes) === 1;
  }

  /** Total committed + reserved spend in the last window (for reports and tests). */
  used(agentId: string, windowMs: number, now = Date.now()): number {
    return Number(
      (
        this.db
          .prepare("SELECT COALESCE(SUM(usd_cents),0) AS s FROM reservations WHERE agent_id=? AND status IN ('reserved','committed') AND created_at >= ?")
          .get(agentId, now - windowMs) as { s: number }
      ).s,
    );
  }

  close(): void {
    this.db.close();
  }
}
