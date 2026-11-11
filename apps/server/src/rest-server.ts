import { agentView, checkApproval, checkFreeze, publishedRecipients, RateLimiter, x402Intent, x402Problems, type AccessStore, type ApprovalVerifier, type SignedApproval, type X402Accept, type X402Recipients } from "@sealed-intent/core";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AccountWatcher, CustodyFreezer, Preflight, ReceiptStore, Reconciler, SharedBlocklist } from "@sealed-intent/core";
import { bearer, type Auth } from "./auth";
import type { Demo } from "./demo";

/**
 * Every answer carries SeIn-Api-Version. Agents may send Idempotency-Key on preflight and execute: a
 * repeat gets the first answer and is not acted on twice. An agent with a signing key must also send
 * X-SeIn-Timestamp and X-SeIn-Signature.
 *
 *   POST /v1/preflight          agent token   { intent, agentQuote? } -> decision
 *   POST /v1/execute            agent token   { decisionId }          -> { status, txHash }
 *   POST /v1/approve            owner token, or a wallet signature when an owner account is set   { decisionId, approver | signed }
 *   POST /v1/reject             same
 *   POST /v1/agents/issue       owner token   { agentId, agentKey? }  -> token, shown once
 *   POST /v1/agents/revoke      owner token   { agentId }
 *   GET  /v1/proofs/:id                       -> where the receipt sits in an anchored batch
 *   POST /v1/review/links       owner token   -> a link per waiting decision, for approving with a wallet in the browser
 *   GET  /v1/review/:id         "Review <key>" from that link, or owner token -> what the owner is asked
 *   POST /v1/freeze             also accepts { signed } from the owner's wallet
 *
 * The approve page on the public site calls the review, approve, reject and freeze routes from the owner's
 * browser, so those answer CORS requests from SEALED_WEB_ORIGINS. Nothing else does.
 *   GET  /v1/pending            owner token   -> WARN decisions waiting for a human, decrypted
 *   POST /v1/freeze             owner token   { reason }
 *   POST /v1/unfreeze           owner token
 *   POST /v1/counterparty/accept-code  owner token   { account }   accept a contract's current code
 *   POST /v1/blocklist/confirm  owner token   { account }   an agent's report now blocks
 *   POST /v1/x402/check         agent token   { resourceUrl, accept, taskText }   a 402 payment request, before the agent's wallet signs it
 *   POST /v1/lessons            owner token   { neverPay[], rules[] }   from a Checkpoint: the accounts block at once, the rules go to the agents
 *   GET  /v1/lessons            agent or owner token   -> the rules and accounts to avoid
 *   POST /v1/watch/accept       owner token   { account }   accept the account's keys and code as they are now
 *   POST /v1/reconcile/accept   owner token                 accept the wallet's transaction history as it is now
 *   GET  /v1/status                           -> { frozen, mode }; the owner also gets the reason
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
  watcher?: AccountWatcher;
  reconciler?: Reconciler;
  /** the owner's freeze also reaches the custody wallet on chain */
  custody?: CustodyFreezer;
  access?: AccessStore;
  /** when set, approving needs this account's wallet signature; the token is not enough */
  ownerAccount?: string;
  approvals?: ApprovalVerifier;
  agentRequestsPerMinute?: number;
  /** origins of the site whose approve page may call this gateway from a browser */
  webOrigins?: string[];
  /** where the approve page lives, and where the owner's browser reaches this gateway */
  webUrl?: string;
  publicUrl?: string;
  network?: string;
  /** the public demo route, only on a hosted SeIn */
  demo?: Demo;
  /** where taught lessons are kept; in memory only when absent */
  lessonsPath?: string;
  /** reads a service's published x402 payees; tests pass a stand-in */
  x402Payees?: (resourceUrl: string) => Promise<X402Recipients | undefined>;
}

const BROWSER_ROUTES = /^(GET \/v1\/review\/[0-9a-f-]{36}|POST \/v1\/(approve|reject|freeze|try)|GET \/v1\/try|GET \/health)$/;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256_000) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function corsFor(req: IncomingMessage, res: ServerResponse, origins: string[] | undefined, route: string): boolean {
  const origin = req.headers.origin;
  if (!origin || !origins?.includes(origin)) return false;
  const preflightRoute = req.method === "OPTIONS" ? `${req.headers["access-control-request-method"] ?? ""} ${route.slice(route.indexOf(" ") + 1)}` : route;
  if (!BROWSER_ROUTES.test(preflightRoute)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // the page is public and the gateway is on the owner's own machine
  if (req.headers["access-control-request-private-network"]) res.setHeader("Access-Control-Allow-Private-Network", "true");
  return true;
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "SeIn-Api-Version": "1" });
  res.end(JSON.stringify(data, null, 2));
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createRestServer(deps: RestDeps): Server {
  const { preflight, blocklist, receipts, offline, auth, watcher, reconciler, custody, access, ownerAccount, approvals, webOrigins } = deps;
  const limiter = new RateLimiter(deps.agentRequestsPerMinute ?? 120);
  const lessons: { rules: string[]; neverPay: string[] } = deps.lessonsPath && existsSync(deps.lessonsPath) ? JSON.parse(readFileSync(deps.lessonsPath, "utf8")) : { rules: [], neverPay: [] };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      const browser = corsFor(req, res, webOrigins, route);
      if (req.method === "OPTIONS") {
        res.writeHead(browser ? 204 : 403);
        return res.end();
      }
      if (deps.demo && url.pathname === "/v1/try") {
        if (req.method === "GET") return send(res, 200, { network: deps.network, ...deps.demo.quota() });
        if (req.method === "POST") {
          // behind Cloud Run the visitor's address is the first one in X-Forwarded-For
          const visitor = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0]!.trim();
          let input: Record<string, unknown>;
          try {
            input = JSON.parse(await readBody(req)) as Record<string, unknown>;
          } catch {
            return send(res, 400, { error: "send JSON" });
          }
          const out = await deps.demo.handle(visitor, input);
          return send(res, out.status, out.body);
        }
      }
      const token = bearer(req);
      const agentId = access?.agentForToken(token) ?? auth.agentForToken(token);
      const isOwner = sameToken(token, auth.ownerToken);
      const raw = req.method === "POST" ? await readBody(req) : "";
      const body = async (_r?: IncomingMessage): Promise<Record<string, unknown>> => (raw ? (JSON.parse(raw) as Record<string, unknown>) : {});

      if (agentId) {
        if (!limiter.allow(agentId)) return send(res, 429, { error: "too many requests" });
        const key = access?.keyOf(agentId);
        if (key) {
          const header = (name: string) => req.headers[name] as string | undefined;
          const signed = access!.checkSignature(key, { timestamp: header("x-sein-timestamp"), signature: header("x-sein-signature") }, req.method ?? "", url.pathname, raw);
          if (!signed.ok) return send(res, 401, { error: signed.reason });
        }
      }

      /** Runs an agent action once per Idempotency-Key. */
      const once = async (run: () => Promise<unknown>) => {
        const key = req.headers["idempotency-key"] as string | undefined;
        if (!key || !access || !agentId) return send(res, 200, await run());
        const prior = access.claim(agentId, key, route);
        if (prior === "busy") return send(res, 409, { error: "a request with this key is still running" });
        if (prior) {
          res.writeHead(prior.status, { "Content-Type": "application/json", "SeIn-Api-Version": "1", "Idempotent-Replay": "true" });
          return res.end(prior.answer);
        }
        try {
          const answer = await run();
          // "not yet" (waiting for the owner, frozen) changes nothing, so the same key may try again later
          const nothingHappened = (answer as { status?: string; refusedByCustody?: boolean })?.status === "not_sent" && !(answer as { refusedByCustody?: boolean }).refusedByCustody;
          if (nothingHappened) access.release(agentId, key, route);
          else access.settle(agentId, key, route, 200, JSON.stringify(answer, null, 2));
          return send(res, 200, answer);
        } catch (err) {
          access.release(agentId, key, route);
          throw err;
        }
      };

      if (route === "GET /health") return send(res, 200, { ok: true, mode: offline ? "offline" : "live" });
      if (route === "GET /v1/status") {
        // the reason can name an agent, so only the owner gets it
        const { frozen, mode, ...detail } = preflight.status();
        return send(res, 200, isOwner ? { frozen, mode, ...detail } : { frozen, mode });
      }
      if (route === "GET /v1/pending") {
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        return send(res, 200, preflight.reviewQueue());
      }
      if (route === "POST /v1/freeze" || route === "POST /v1/unfreeze") {
        const { reason, signed } = (await body(req)) as { reason?: string; signed?: SignedApproval };
        let by = "owner";
        if (route.endsWith("freeze") && !route.endsWith("unfreeze") && signed && ownerAccount && approvals) {
          const check = await checkFreeze(signed, ownerAccount, approvals);
          if (!check.ok) return send(res, 401, { error: check.reason });
          by = ownerAccount;
        } else if (!isOwner) return send(res, 401, { error: "owner token required" });
        if (route.endsWith("unfreeze")) return send(res, 200, { ok: preflight.unfreeze("owner"), ...preflight.status() });
        preflight.freeze(reason || (by === "owner" ? "owner request" : "owner stopped all payments from the web"), by);
        const onChain = await custody?.freeze().catch((err: Error) => ({ error: err.message }));
        return send(res, 200, { ...preflight.status(), custodyFreeze: onChain ?? "not configured" });
      }

      if (route === "POST /v1/preflight") {
        if (!agentId) return send(res, 401, { error: "agent token required" });
        const input = await body(req);
        return once(async () => agentView(await preflight.evaluate({ agentId, intent: input.intent, agentQuote: input.agentQuote as never })));
      }
      if (route === "POST /v1/x402/check") {
        if (!agentId) return send(res, 401, { error: "agent token required" });
        const b = (await body(req)) as { resourceUrl?: string; accept?: X402Accept; taskText?: string };
        if (!b.resourceUrl || !b.accept) return send(res, 400, { error: "resourceUrl and accept are required" });
        let payees: X402Recipients | undefined;
        try {
          payees = await (deps.x402Payees ?? publishedRecipients)(b.resourceUrl);
        } catch {
          payees = undefined;
        }
        const problems = x402Problems(b.accept, payees, deps.network === "testnet" ? "testnet" : "mainnet");
        // a 402 that is wrong in itself is refused before it costs a check; nothing is signed either way
        if (problems.length) return send(res, 200, { verdict: "BLOCK", reasonCodes: problems, warnCodes: [], x402: { payeePublished: false } });
        return once(async () => ({ ...agentView(await preflight.evaluate({ agentId, intent: x402Intent(b.accept!, b.taskText ?? "") })), x402: { payeePublished: true } }));
      }
      if (route === "POST /v1/execute") {
        if (!agentId) return send(res, 401, { error: "agent token required" });
        const { decisionId } = (await body(req)) as { decisionId?: string };
        if (!decisionId) return send(res, 400, { error: "decisionId required" });
        return once(() => preflight.execute(decisionId, agentId));
      }
      if (route === "POST /v1/approve" || route === "POST /v1/reject") {
        const action = route.endsWith("approve") ? "approve" : "reject";
        const { decisionId, approver, signed } = (await body(req)) as { decisionId?: string; approver?: string; signed?: SignedApproval };
        if (ownerAccount) {
          if (!signed || !decisionId || !approvals) return send(res, 401, { error: "this owner approves with a wallet signature" });
          if (signed.action !== action || signed.decisionId !== decisionId) return send(res, 400, { error: "the signature is for something else" });
          const check = await checkApproval(signed, { owner: ownerAccount, review: preflight.review(decisionId) }, approvals);
          if (!check.ok) return send(res, 401, { error: check.reason });
          return send(res, 200, action === "approve" ? preflight.approve(decisionId, ownerAccount) : preflight.reject(decisionId, ownerAccount));
        }
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        if (!decisionId || !approver) return send(res, 400, { error: "decisionId and approver required" });
        return send(res, 200, action === "approve" ? preflight.approve(decisionId, approver) : preflight.reject(decisionId, approver));
      }
      if (route === "POST /v1/review/links") {
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        if (!access) return send(res, 400, { error: "agent access is not configured" });
        const web = deps.webUrl ?? "https://sein-near.vercel.app";
        const gateway = deps.publicUrl ?? "http://127.0.0.1:8787";
        // the part after # stays in the browser: the site never sees the gateway address or the key
        const links = preflight.reviewQueue().filter((r) => !r.approvedBy).map((r) => ({ decisionId: r.decisionId, link: `${web}/approve/${r.decisionId}#g=${encodeURIComponent(gateway)}&k=${access.issueReviewKey(r.decisionId)}` }));
        return send(res, 200, { links });
      }
      const reviewPath = url.pathname.match(/^\/v1\/review\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && reviewPath) {
        const id = reviewPath[1]!;
        const header = req.headers.authorization;
        const key = header?.startsWith("Review ") ? header.slice(7).trim() : undefined;
        if (!isOwner && !access?.reviewKeyValid(id, key)) return send(res, 401, { error: "this link is not valid or has expired" });
        const review = preflight.review(id);
        if (!review) return send(res, 404, { error: "nothing is waiting under this id: it was decided already, or never needed you" });
        return send(res, 200, { review, owner: ownerAccount, network: deps.network ?? "mainnet", signRequired: !!ownerAccount });
      }
      if (route === "POST /v1/agents/issue" || route === "POST /v1/agents/revoke") {
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        if (!access) return send(res, 400, { error: "agent access is not configured" });
        const { agentId: id, agentKey } = (await body(req)) as { agentId?: string; agentKey?: string };
        if (!id) return send(res, 400, { error: "agentId required" });
        return send(res, 200, route.endsWith("issue") ? { agentId: id, token: access.issue(id, agentKey) } : { ok: access.revoke(id) });
      }
      if (route === "POST /v1/blocklist/report") {
        if (!agentId) return send(res, 401, { error: "agent token required" });
        const b = (await body(req)) as { account: string; reason: string; evidence: string[] };
        return send(res, 200, blocklist.report({ account: b.account, reason: b.reason, evidence: b.evidence ?? [], reportedBy: agentId }));
      }
      if (route === "POST /v1/watch/accept") {
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        const { account } = (await body(req)) as { account?: string };
        if (!account) return send(res, 400, { error: "account required" });
        return send(res, 200, { ok: (await watcher?.accept(account)) ?? false });
      }
      if (route === "POST /v1/reconcile/accept") {
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        return send(res, 200, { ok: (await reconciler?.accept()) ?? false });
      }
      if (route === "POST /v1/lessons") {
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        const b = (await body(req)) as { neverPay?: { account?: string; why?: string }[]; rules?: unknown[] };
        const accounts = (b.neverPay ?? []).filter((n) => typeof n.account === "string" && /^[a-z0-9._-]{2,64}$/.test(n.account)).slice(0, 50);
        const rules = (b.rules ?? []).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 300)).slice(0, 20);
        // the owner taught it, so it blocks at once; the agent cannot pay these accounts even if it forgets the lesson
        for (const n of accounts) {
          if (blocklist.find(n.account!)) blocklist.confirm(n.account!);
          else blocklist.report({ account: n.account!, reason: (n.why ?? "taught by the owner").slice(0, 200), evidence: ["SeIn Checkpoint lesson"], reportedBy: "owner", confirmed: true });
        }
        lessons.rules = [...new Set([...lessons.rules, ...rules])].slice(-40);
        lessons.neverPay = [...new Set([...lessons.neverPay, ...accounts.map((n) => n.account!)])];
        if (deps.lessonsPath) writeFileSync(deps.lessonsPath, JSON.stringify(lessons, null, 2), { mode: 0o600 });
        return send(res, 200, { blocked: accounts.length, rules: lessons.rules.length });
      }
      if (route === "GET /v1/lessons") {
        if (!agentId && !isOwner) return send(res, 401, { error: "agent token required" });
        return send(res, 200, lessons);
      }
      if (route === "POST /v1/blocklist/confirm") {
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        const { account } = (await body(req)) as { account?: string };
        const e = account && blocklist.confirm(account);
        return e ? send(res, 200, e) : send(res, 404, { error: "no report for that account" });
      }
      if (route === "POST /v1/counterparty/accept-code") {
        if (!isOwner) return send(res, 401, { error: "owner token required" });
        const { account } = (await body(req)) as { account?: string };
        if (!account) return send(res, 400, { error: "account required" });
        return send(res, 200, await preflight.acceptCounterpartyCode(account, "owner"));
      }
      if (route === "GET /v1/blocklist") return send(res, 200, blocklist.all());
      const p = url.pathname.match(/^\/v1\/proofs\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && p) {
        const proof = receipts.loadProof(p[1]!);
        return proof ? send(res, 200, proof) : send(res, 404, { error: "not anchored yet" });
      }
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
