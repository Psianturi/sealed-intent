import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutableAction } from "./executor";
import type { DeclaredIntent } from "./intent";
import { DatabaseSync } from "./sqlite";

/**
 * Decisions waiting for approval or execution. Stored in SQLite so a WARN issued by
 * one process (MCP) can be approved by another (REST) and survives a restart.
 */
export interface PendingDecision {
  decisionId: string;
  agentId: string;
  intent: DeclaredIntent;
  action: ExecutableAction;
  reservationId: string;
  inCents: number;
  verdict: "ALLOW" | "WARN";
  approvedBy?: string;
  createdAt: number;
}

export class PendingStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending (
        decision_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        verdict TEXT NOT NULL,
        payload TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        in_cents INTEGER NOT NULL,
        approved_by TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  put(p: PendingDecision): void {
    this.db
      .prepare("INSERT INTO pending (decision_id, agent_id, verdict, payload, reservation_id, in_cents, approved_by, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(p.decisionId, p.agentId, p.verdict, JSON.stringify({ intent: p.intent, action: p.action }), p.reservationId, p.inCents, p.approvedBy ?? null, p.createdAt);
  }

  get(decisionId: string): PendingDecision | undefined {
    const row = this.db.prepare("SELECT * FROM pending WHERE decision_id=?").get(decisionId) as
      | { decision_id: string; agent_id: string; verdict: string; payload: string; reservation_id: string; in_cents: number; approved_by: string | null; created_at: number }
      | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload) as { intent: DeclaredIntent; action: ExecutableAction };
    return {
      decisionId: row.decision_id,
      agentId: row.agent_id,
      intent: payload.intent,
      action: payload.action,
      reservationId: row.reservation_id,
      inCents: Number(row.in_cents),
      verdict: row.verdict as "ALLOW" | "WARN",
      approvedBy: row.approved_by ?? undefined,
      createdAt: Number(row.created_at),
    };
  }

  approve(decisionId: string, approver: string): boolean {
    return Number(this.db.prepare("UPDATE pending SET approved_by=? WHERE decision_id=? AND verdict='WARN'").run(approver, decisionId).changes) === 1;
  }

  /** Removes the row and returns it, so a concurrent second execute gets nothing. */
  take(decisionId: string): PendingDecision | undefined {
    const p = this.get(decisionId);
    if (!p) return undefined;
    const removed = Number(this.db.prepare("DELETE FROM pending WHERE decision_id=?").run(decisionId).changes) === 1;
    return removed ? p : undefined;
  }

  close(): void {
    this.db.close();
  }
}
