import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Vault } from "@sealed-intent/receipt";
import type { ExecutableAction } from "./executor";
import type { DeclaredIntent } from "./intent";
import { DatabaseSync } from "./sqlite";

/**
 * Decisions waiting for approval or execution. Stored in SQLite so a WARN issued by one
 * process (MCP) can be approved by another (REST) and survives a restart. Everything
 * about the payment is sealed; only ids, status and time stay readable.
 */
export interface PendingDecision {
  decisionId: string;
  agentId: string;
  intent: DeclaredIntent;
  action: ExecutableAction;
  reservationId: string;
  inCents: number;
  verdict: "ALLOW" | "WARN";
  warnCodes?: string[];
  route?: string;
  routeNote?: RouteNote;
  approvedBy?: string;
  createdAt: number;
}

/** What the owner is told before a private route is signed. */
export interface RouteNote {
  hidden: string[];
  stillPublic: string[];
  /** extra cost compared with the public route; undefined when the two quotes could not be compared */
  extraCostBps?: number;
}

type SealedPart = Pick<PendingDecision, "agentId" | "intent" | "action" | "reservationId" | "inCents" | "warnCodes" | "route" | "routeNote">;
interface Row {
  decision_id: string;
  verdict: string;
  payload: string;
  approved_by: string | null;
  created_at: number;
}

export class PendingStore {
  private db: DatabaseSync;

  constructor(path: string, private readonly vault: Vault) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_sealed (
        decision_id TEXT PRIMARY KEY,
        verdict TEXT NOT NULL,
        payload TEXT NOT NULL,
        approved_by TEXT,
        created_at INTEGER NOT NULL
      );
    `);
  }

  put(p: PendingDecision): void {
    const sealed: SealedPart = { agentId: p.agentId, intent: p.intent, action: p.action, reservationId: p.reservationId, inCents: p.inCents, warnCodes: p.warnCodes, route: p.route, routeNote: p.routeNote };
    this.db.prepare("INSERT INTO pending_sealed (decision_id, verdict, payload, approved_by, created_at) VALUES (?,?,?,?,?)").run(p.decisionId, p.verdict, this.vault.seal(sealed), p.approvedBy ?? null, p.createdAt);
  }

  private decode(row: Row): PendingDecision {
    return {
      ...this.vault.open<SealedPart>(row.payload),
      decisionId: row.decision_id,
      verdict: row.verdict as "ALLOW" | "WARN",
      approvedBy: row.approved_by ?? undefined,
      createdAt: Number(row.created_at),
    };
  }

  get(decisionId: string): PendingDecision | undefined {
    const row = this.db.prepare("SELECT * FROM pending_sealed WHERE decision_id=?").get(decisionId) as Row | undefined;
    return row ? this.decode(row) : undefined;
  }

  /** Newest first, for the owner's review. */
  list(): PendingDecision[] {
    return (this.db.prepare("SELECT * FROM pending_sealed ORDER BY created_at DESC").all() as unknown as Row[]).map((r) => this.decode(r));
  }

  approve(decisionId: string, approver: string): boolean {
    return Number(this.db.prepare("UPDATE pending_sealed SET approved_by=? WHERE decision_id=? AND verdict='WARN'").run(approver, decisionId).changes) === 1;
  }

  /** Removes the row and returns it, so a concurrent second execute gets nothing. */
  take(decisionId: string): PendingDecision | undefined {
    const p = this.get(decisionId);
    if (!p) return undefined;
    const removed = Number(this.db.prepare("DELETE FROM pending_sealed WHERE decision_id=?").run(decisionId).changes) === 1;
    return removed ? p : undefined;
  }

  purge(retentionDays: number, now = Date.now()): number {
    return Number(this.db.prepare("DELETE FROM pending_sealed WHERE created_at < ?").run(now - retentionDays * 86_400_000).changes);
  }

  close(): void {
    this.db.close();
  }
}
