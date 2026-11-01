import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Preflight, ReceiptStore, SharedBlocklist } from "@sealed-intent/core";
import { bearer, type Auth } from "./auth";

/**
 *   POST /v1/preflight          agent token   { intent, agentQuote? } -> decision
 *   POST /v1/execute            agent token   { decisionId }          -> { status, txHash }
 *   POST /v1/approve            owner token   { decisionId, approver }
 *   POST /v1/reject             owner token   { decisionId, approver }
 *   POST /v1/blocklist/report   agent token   { account, reason, evidence[], reportedBy }
 *   GET  /v1/blocklist                        -> shared blocklist (signed entries)
 *   GET  /v1/receipts/:id                     -> public receipt
 *   GET  /health
 */
export interface RestDeps {
  preflight: Preflight;
  blocklist: SharedBlocklist;
  receipts: ReceiptStore;
  offline: boolean;
  auth: Auth;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createRestServer(deps: RestDeps): Server {
  const { preflight, blocklist, receipts, offline, auth } = deps;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      const token = bearer(req);
      const agentId = auth.agentForToken(token);
      const isOwner = sameToken(token, auth.ownerToken);

      if (route === "GET /health") return send(res, 200, { ok: true, mode: offline ? "offline" : "live" });

      if (route === "POST /v1/preflight") {
        if (!agentId) return send(res, 401, { error: "agent token required" });
        const input = await body(req);
        const { metrics: _private, receiptPath: _path, ...decision } = await preflight.evaluate({ agentId, intent: input.intent, agentQuote: input.agentQuote as never });
        return send(res, 200, decision);
      }
      if (route === "POST /v1/execute") {
        if (!agentId) return send(res, 401, { error: "agent token required" });
        const { decisionId } = (await body(req)) as { decisionId?: string };
        if (!decisionId) return send(res, 400, { error: "decisionId required" });
        return send(res, 200, await preflight.execute(decisionId, agentId));
      }
      if (route === "POST /v1/approve" || route === "POST /v1/reject") {
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        const { decisionId, approver } = (await body(req)) as { decisionId?: string; approver?: string };
        if (!decisionId || !approver) return send(res, 400, { error: "decisionId and approver required" });
        return send(res, 200, route.endsWith("approve") ? preflight.approve(decisionId, approver) : preflight.reject(decisionId, approver));
      }
      if (route === "POST /v1/blocklist/report") {
        if (!agentId) return send(res, 401, { error: "agent token required" });
        const b = (await body(req)) as { account: string; reason: string; evidence: string[] };
        return send(res, 200, blocklist.report({ account: b.account, reason: b.reason, evidence: b.evidence ?? [], reportedBy: agentId }));
      }
      if (route === "GET /v1/blocklist") return send(res, 200, blocklist.all());
      const m = url.pathname.match(/^\/v1\/receipts\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && m) {
        const r = receipts.load(m[1]!);
        return r ? send(res, 200, r) : send(res, 404, { error: "not found" });
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      send(res, 400, { error: (err as Error).message });
    }
  });
}
