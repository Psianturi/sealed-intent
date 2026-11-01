#!/usr/bin/env tsx
/**
 * REST API for agents that do not speak MCP.
 *
 *   POST /v1/preflight          { intent, agentQuote? } -> { decisionId, verdict, reasonCodes, warnCodes, route }
 *   POST /v1/approve            { decisionId, approver } (human, for WARN)
 *   POST /v1/reject             { decisionId, approver }
 *   POST /v1/execute            { decisionId }          -> { status, txHash }
 *   GET  /v1/receipts/:id                                -> public receipt (safe to share)
 *   POST /v1/blocklist/report   { account, reason, evidence[], reportedBy }
 *   GET  /v1/blocklist                                   -> shared blocklist (signed entries)
 *   GET  /health
 *
 * Bind to localhost by default: approve/reject are human actions and must not be
 * reachable by the agent itself. Put real auth in front before exposing it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ReceiptStore } from "@sealed-intent/core";
import { createApp } from "./app";

const { preflight, blocklist, offline } = createApp();
const receipts = new ReceiptStore();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

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

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /health") return send(res, 200, { ok: true, mode: offline ? "offline" : "live" });
    if (route === "POST /v1/preflight") {
      const input = await body(req);
      const { metrics: _private, receiptPath: _path, ...decision } = await preflight.evaluate({ intent: input.intent, agentQuote: input.agentQuote as never });
      return send(res, 200, decision);
    }
    if (route === "POST /v1/approve" || route === "POST /v1/reject") {
      const { decisionId, approver } = (await body(req)) as { decisionId?: string; approver?: string };
      if (!decisionId || !approver) return send(res, 400, { error: "decisionId and approver required" });
      return send(res, 200, route.endsWith("approve") ? preflight.approve(decisionId, approver) : preflight.reject(decisionId, approver));
    }
    if (route === "POST /v1/execute") {
      const { decisionId } = (await body(req)) as { decisionId?: string };
      if (!decisionId) return send(res, 400, { error: "decisionId required" });
      return send(res, 200, await preflight.execute(decisionId));
    }
    if (route === "POST /v1/blocklist/report") {
      const b = (await body(req)) as { account: string; reason: string; evidence: string[]; reportedBy: string };
      return send(res, 200, blocklist.report({ account: b.account, reason: b.reason, evidence: b.evidence ?? [], reportedBy: b.reportedBy }));
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
}).listen(port, host, () => console.log(`Sealed Intent REST (${offline ? "offline" : "LIVE"}) on http://${host}:${port}`));
