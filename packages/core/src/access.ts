import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "./sqlite";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const SIGNATURE_WINDOW_MS = 60_000;

/** What an agent signs, so a stolen token alone is not enough. */
export const requestToSign = (timestamp: string, method: string, path: string, rawBody: string) => `${timestamp}.${method}.${path}.${sha(rawBody)}`;

export function verifyAgentSignature(publicKeyHex: string, message: string, signatureHex: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/**
 * Who may call the gateway. Tokens are stored only as hashes, each agent can have a signing key,
 * and revoking takes effect on the next request. Idempotent answers live here too.
 */
export class AccessStore {
  private db: DatabaseSync;
  private seen = new Map<string, number>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 10000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_access (agent_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, agent_key TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS idempotency (agent_id TEXT, key TEXT, route TEXT, status INTEGER, answer TEXT, at INTEGER NOT NULL, PRIMARY KEY (agent_id, key, route));
      CREATE TABLE IF NOT EXISTS review_keys (decision_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
  }

  /** Returns the token once. A new token replaces the old one. */
  issue(agentId: string, agentKey?: string, now = Date.now()): string {
    const token = randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO agent_access VALUES (?,?,?,?,NULL) ON CONFLICT(agent_id) DO UPDATE SET token_hash=excluded.token_hash, agent_key=excluded.agent_key, revoked_at=NULL").run(agentId, sha(token), agentKey ?? null, now);
    return token;
  }

  revoke(agentId: string, now = Date.now()): boolean {
    return Number(this.db.prepare("UPDATE agent_access SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL").run(now, agentId).changes) > 0;
  }

  agentForToken(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const row = this.db.prepare("SELECT agent_id FROM agent_access WHERE token_hash=? AND revoked_at IS NULL").get(sha(token)) as { agent_id: string } | undefined;
    return row?.agent_id;
  }

  keyOf(agentId: string): string | undefined {
    const row = this.db.prepare("SELECT agent_key FROM agent_access WHERE agent_id=? AND revoked_at IS NULL").get(agentId) as { agent_key: string | null } | undefined;
    return row?.agent_key ?? undefined;
  }

  /** A key that lets a browser read one waiting decision, so the owner can review it from a link. Shown once. */
  issueReviewKey(decisionId: string, ttlMs = 24 * 3_600_000, now = Date.now()): string {
    const key = randomBytes(24).toString("hex");
    this.db.prepare("INSERT OR REPLACE INTO review_keys VALUES (?,?,?)").run(decisionId, sha(key), now + ttlMs);
    return key;
  }

  reviewKeyValid(decisionId: string, key: string | undefined, now = Date.now()): boolean {
    if (!key) return false;
    const row = this.db.prepare("SELECT key_hash, expires_at FROM review_keys WHERE decision_id=?").get(decisionId) as { key_hash: string; expires_at: number } | undefined;
    return !!row && Number(row.expires_at) > now && row.key_hash === sha(key);
  }

  /** Checks the signature and refuses a repeat of the same signed request. */
  checkSignature(agentKey: string, sig: { timestamp?: string; signature?: string }, method: string, path: string, rawBody: string, now = Date.now()): { ok: boolean; reason?: string } {
    if (!sig.timestamp || !sig.signature) return { ok: false, reason: "this agent must sign its requests" };
    const at = Number(sig.timestamp);
    if (!Number.isFinite(at) || Math.abs(now - at) > SIGNATURE_WINDOW_MS) return { ok: false, reason: "signature timestamp is out of range" };
    if (!verifyAgentSignature(agentKey, requestToSign(sig.timestamp, method, path, rawBody), sig.signature)) return { ok: false, reason: "bad signature" };
    for (const [k, t] of this.seen) if (now - t > 2 * SIGNATURE_WINDOW_MS) this.seen.delete(k);
    if (this.seen.has(sig.signature)) return { ok: false, reason: "this signed request was already used" };
    this.seen.set(sig.signature, now);
    return { ok: true };
  }

  /** Reserves the key. Returns the earlier answer, "busy" if another request holds it, or undefined to go ahead. */
  claim(agentId: string, key: string, route: string, now = Date.now()): { status: number; answer: string } | "busy" | undefined {
    this.db.prepare("DELETE FROM idempotency WHERE at < ?").run(now - 24 * 3_600_000);
    const row = this.db.prepare("SELECT status, answer FROM idempotency WHERE agent_id=? AND key=? AND route=?").get(agentId, key, route) as { status: number | null; answer: string | null } | undefined;
    if (row) return row.answer === null ? "busy" : { status: Number(row.status), answer: row.answer };
    this.db.prepare("INSERT INTO idempotency VALUES (?,?,?,NULL,NULL,?)").run(agentId, key, route, now);
    return undefined;
  }

  settle(agentId: string, key: string, route: string, status: number, answer: string): void {
    this.db.prepare("UPDATE idempotency SET status=?, answer=? WHERE agent_id=? AND key=? AND route=?").run(status, answer, agentId, key, route);
  }

  /** The request failed before it had an answer: the key may be used again. */
  release(agentId: string, key: string, route: string): void {
    this.db.prepare("DELETE FROM idempotency WHERE agent_id=? AND key=? AND route=? AND answer IS NULL").run(agentId, key, route);
  }
}

/** A plain per-agent request limit, separate from spending limits. */
export class RateLimiter {
  private counts = new Map<string, { windowStart: number; n: number }>();
  constructor(private readonly perMinute: number) {}

  allow(agentId: string, now = Date.now()): boolean {
    const c = this.counts.get(agentId);
    if (!c || now - c.windowStart >= 60_000) {
      this.counts.set(agentId, { windowStart: now, n: 1 });
      return true;
    }
    c.n += 1;
    return c.n <= this.perMinute;
  }
}
