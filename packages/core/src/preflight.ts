import { randomUUID } from "node:crypto";
import { buildExecutionReceipt, buildReceipt, commit, type IssuerKey, type Opening, type Receipt, type TeeEvidence, type Vault, type Verdict } from "@sealed-intent/receipt";
import { BudgetLedger } from "./budget";
import { checkCall, checkDryLiveDrift, checkQuote, checkTransfer, type QuoteMetrics } from "./checks";
import { assessCounterparty, type CounterpartyDeps } from "./counterparty";
import type { ExecutableAction, Executor, ExecutionResult } from "./executor";
import type { FreezeState, FreezeStore } from "./freeze";
import { scanTaskText } from "./injection";
import { AgentId, DeclaredIntent, type SwapIntent } from "./intent";
import type { OneClickClient, QuoteRequest, QuoteResponse, TokenResponse } from "./oneclick";
import type { PendingDecision, PendingStore, RouteNote } from "./pending";
import type { Policy } from "./policy";
import { checkQuoteSignature } from "./quote-signature";
import type { ReceiptStore } from "./store";
import { TeeUnverifiedError, type TeeChecker } from "./tee-check";

const LIMIT_CODES = new Set(["ABOVE_PER_TX_LIMIT", "HOURLY_BUDGET_EXCEEDED", "DAILY_BUDGET_EXCEEDED", "TX_RATE_EXCEEDED"]);
/** The agent and the public receipt learn that a limit was hit, not which one. */
const publicCodes = (codes: string[]) => [...new Set(codes.map((c) => (LIMIT_CODES.has(c) ? "LIMIT_EXCEEDED" : c)))];

export interface PreflightDeps {
  oneclick: OneClickClient;
  policy: Policy;
  ledger: BudgetLedger;
  pending: PendingStore;
  freeze: FreezeStore;
  issuer: IssuerKey;
  store: ReceiptStore;
  executor: Executor;
  counterparty: CounterpartyDeps;
  tee?: TeeChecker;
  /** 1Click manager key; undefined = the SDK's built-in production key */
  quoteManagerPublicKey?: string;
  /** keys the hourly draw when policy.secrecy.perTxJitterPct is on */
  vault?: Vault;
  /** which chain this instance pays on; recorded in receipts */
  network?: string;
  /** told about every payment, so an unexplained transaction stands out */
  spendLog?: SpendLog;
  /** the public id on the registry for agents whose owner made them public */
  registryIdOf?: (agentId: string) => string | undefined;
}

export interface SpendLog {
  begin(decisionId: string): void;
  end(decisionId: string, hashes: string[]): void;
}

/** What the agent gets back. Deliberately thin: no thresholds, no amounts, no policy. */
export interface Decision {
  decisionId: string;
  verdict: Verdict;
  reasonCodes: string[];
  warnCodes: string[];
  route: Receipt["public"]["route"];
  receiptPath: string;
  /** which limit was hit. For the owner; agentView removes it. */
  detailCodes?: string[];
}

/** Exactly what an agent may see of a decision. */
export function agentView<T extends Decision & { metrics?: unknown }>(d: T): Omit<T, "receiptPath" | "detailCodes" | "metrics"> {
  const { receiptPath: _p, detailCodes: _d, metrics: _m, ...view } = d;
  return view;
}

/** What the owner reads before approving a WARN. */
export interface OwnerReview {
  decisionId: string;
  createdAt: string;
  agentId: string;
  kind: string;
  token?: string;
  amount?: string;
  recipient?: string;
  usd: number;
  warnCodes: string[];
  route?: string;
  routeNote?: RouteNote;
  approvedBy?: string;
}

export interface EvaluateInput {
  /** Who is asking. Set by the server from the caller's credential, never from the request body. */
  agentId: string;
  intent: unknown;
  agentQuote?: QuoteResponse;
}

interface Gathered {
  block: Set<string>;
  review: Set<string>;
  metrics?: QuoteMetrics;
  action?: ExecutableAction;
  quote?: QuoteResponse;
  dryQuote?: QuoteResponse;
  routeNote?: RouteNote;
}

export class Preflight {
  constructor(private readonly deps: PreflightDeps) {}

  get mode(): "live" | "offline" {
    return this.deps.oneclick.mode;
  }

  get policy(): Policy {
    return this.deps.policy;
  }

  status(): FreezeState & { mode: "live" | "offline" } {
    return { ...this.deps.freeze.state(), mode: this.mode };
  }

  /** Owner-only. Callers must authenticate the owner before calling these. */
  freeze(reason: string, by: string): void {
    this.deps.freeze.freeze(reason, by);
    this.deps.store.saveAudit(`freeze.${Date.now()}`, { frozen: true, reason, by, at: new Date().toISOString() });
  }

  unfreeze(by: string): boolean {
    const ok = this.deps.freeze.unfreeze();
    if (ok) this.deps.store.saveAudit(`freeze.${Date.now()}`, { frozen: false, by, at: new Date().toISOString() });
    return ok;
  }

  async evaluate(input: EvaluateInput): Promise<Decision & { metrics?: QuoteMetrics }> {
    const { policy } = this.deps;
    const agent = AgentId.safeParse(input.agentId);
    const parsed = DeclaredIntent.safeParse(input.intent);
    if (!agent.success || !parsed.success) {
      return this.finish({ verdict: "BLOCK", block: ["INVALID_INTENT"], review: [], route: "public", agentId: agent.success ? agent.data : "invalid", kind: "invalid" });
    }
    const agentId = agent.data;
    const intent = parsed.data;
    const route: Receipt["public"]["route"] = policy.privatePurposes.includes(intent.purpose) ? `confidential-${policy.confidentialLevel}` : "public";
    const decisionId = randomUUID();
    // named in the enclave's signed request and in the receipt, so the two can be tied together
    const intentCommit = commit(intent);
    const base = { agentId, intent, route, receiptId: decisionId, intentCommit };
    const checkPolicy = this.effectivePolicy(agentId);

    if (this.deps.freeze.state().frozen) {
      return this.finish({ ...base, verdict: "BLOCK", block: ["WALLET_FROZEN"], review: [], kind: intent.kind });
    }

    const executable = intent.kind === "swap" || intent.kind === "transfer" || intent.kind === "call";
    if (!executable || policy.actions.never.includes(intent.kind) || !policy.actions.allowed.includes(intent.kind)) {
      if (policy.freeze.onForbiddenAction) this.deps.freeze.freeze(`agent ${agentId} requested ${intent.kind}`, "auto");
      this.deps.freeze.recordBlock(agentId, "block");
      return this.finish({ ...base, verdict: "BLOCK", block: ["ACTION_CLASS_FORBIDDEN"], review: [], kind: intent.kind });
    }
    if (intent.kind !== "swap" && intent.kind !== "transfer" && intent.kind !== "call") throw new Error("unreachable");

    const tokens = await this.deps.oneclick.getTokens();
    const g: Gathered = { block: new Set(), review: new Set() };
    let counterpartyAccount: string;
    if (intent.kind === "swap") {
      await this.gatherSwap(intent, route, tokens, input.agentQuote, g, checkPolicy);
      counterpartyAccount = intent.recipient;
    } else if (intent.kind === "transfer") {
      const r = checkTransfer({ intent, policy: checkPolicy, tokens });
      r.block.forEach((c) => g.block.add(c));
      g.metrics = r.metrics;
      g.action = { kind: "transfer", token: intent.token, recipient: intent.recipient, amount: intent.amount, memo: intent.memo };
      counterpartyAccount = intent.recipient;
    } else {
      const r = checkCall({ intent, policy: checkPolicy, tokens });
      r.block.forEach((c) => g.block.add(c));
      g.metrics = r.metrics;
      g.action = { kind: "call", contract: intent.contract, method: intent.method, args: intent.args, depositYocto: intent.depositYocto };
      counterpartyAccount = intent.contract;
    }

    const cp = await assessCounterparty({ agentId, account: counterpartyAccount, policy }, this.deps.counterparty);
    cp.block.forEach((c) => g.block.add(c));
    cp.review.forEach((c) => g.review.add(c));

    const known = [...policy.allowedRecipients, ...policy.ownAccounts, counterpartyAccount, ...(intent.kind === "swap" ? [intent.refundTo] : [])];
    const scan = scanTaskText(intent.taskText, known);
    if (scan.codes.length) (policy.injection.block ? g.block : g.review).add("PROMPT_INJECTION_SUSPECTED");
    if (!intent.taskText && policy.injection.requireTaskText) g.review.add("TASK_CONTEXT_MISSING");

    let tee: TeeEvidence | undefined;
    if (this.deps.tee) {
      try {
        const { raw, ...evidence } = await this.deps.tee.check({ decisionId, intentCommitment: intentCommit.commitment, intent, quote: input.agentQuote ?? g.quote ?? g.dryQuote, policy, injectionCodes: scan.codes });
        tee = evidence;
        if (raw) this.deps.store.saveTeeExchange(decisionId, raw);
        if (tee.signal === "block") (policy.tee.obeyBlockSignal ? g.block : g.review).add("TEE_SIGNAL_BLOCK");
        if (tee.signal === "warn") g.review.add("TEE_SIGNAL_WARN");
      } catch (err) {
        // an enclave that fails verification never loosens anything
        (policy.tee.required ? g.block : g.review).add(err instanceof TeeUnverifiedError ? "TEE_UNVERIFIED" : "TEE_UNAVAILABLE");
      }
    } else if (policy.tee.required) {
      g.block.add("TEE_UNAVAILABLE");
    }

    // Atomic budget reservation: the last gate. WARN decisions hold budget while a human decides.
    let reservationId: string | undefined;
    const inCents = g.metrics ? Math.ceil(g.metrics.inUsd * 100) : 0;
    if (g.block.size === 0 && g.metrics) {
      const res = this.reserve(agentId, inCents);
      if (res.ok) reservationId = res.reservationId;
      else g.block.add(res.reason);
    }

    const verdict: Verdict = g.block.size ? "BLOCK" : g.review.size ? "WARN" : "ALLOW";
    if (verdict === "BLOCK") {
      // blocks caused only by a cap look like an agent probing for the exact limit
      const probe = [...g.block].every((c) => LIMIT_CODES.has(c));
      const n = this.deps.freeze.recordBlock(agentId, probe ? "limit" : "block");
      if (n.blocks >= policy.freeze.maxBlocksPerHour) this.deps.freeze.freeze(`agent ${agentId} hit ${policy.freeze.maxBlocksPerHour} blocks in an hour`, "auto");
      else if (n.limitProbes >= policy.freeze.maxLimitProbesPerHour) this.deps.freeze.freeze(`agent ${agentId} probed the spending limits ${n.limitProbes} times in an hour`, "auto");
    }
    const decision = await this.finish({ ...base, verdict, block: [...g.block], review: [...g.review], kind: intent.kind, quote: g.quote ?? g.dryQuote, live: g.quote, tee, reservationId });
    if (verdict !== "BLOCK" && g.action && reservationId) {
      this.deps.pending.put({ decisionId: decision.decisionId, agentId, intent, action: g.action, reservationId, inCents, verdict, warnCodes: [...g.review], route, routeNote: g.routeNote, createdAt: Date.now() });
    }
    return { ...decision, metrics: g.metrics };
  }

  /** A fixed cap leaks one bit per probe. With jitter on, the effective cap is redrawn per agent every hour. */
  private effectivePolicy(agentId: string, now = Date.now()): Policy {
    const { policy, vault } = this.deps;
    const pct = policy.secrecy.perTxJitterPct;
    if (!pct || !vault) return policy;
    const draw = parseInt(vault.blind(`jitter:${agentId}:${Math.floor(now / 3_600_000)}`).slice(0, 8), 16) / 0xffffffff;
    return { ...policy, perTxUsd: policy.perTxUsd * (1 - (pct / 100) * draw) };
  }

  /** Owner-only: the WARN decisions waiting for a human, decrypted. */
  reviewQueue(): OwnerReview[] {
    return this.deps.pending
      .list()
      .filter((p) => p.verdict === "WARN")
      .map((p: PendingDecision) => {
        const i = p.intent;
        const money = i.kind === "swap" ? { token: i.tokenIn, amount: i.amountIn, recipient: i.recipient } : i.kind === "transfer" ? { token: i.token, amount: i.amount, recipient: i.recipient } : i.kind === "call" ? { amount: i.depositYocto, recipient: i.contract } : {};
        return { decisionId: p.decisionId, createdAt: new Date(p.createdAt).toISOString(), agentId: p.agentId, kind: i.kind, ...money, usd: p.inCents / 100, warnCodes: p.warnCodes ?? [], route: p.route, routeNote: p.routeNote, approvedBy: p.approvedBy };
      });
  }

  review(decisionId: string): OwnerReview | undefined {
    return this.reviewQueue().find((r) => r.decisionId === decisionId);
  }

  /** Deletes private records past the retention window. */
  purgeExpired(now = Date.now()): number {
    const days = this.deps.policy.retention.privateDays;
    this.deps.ledger.purge(now);
    return this.deps.store.purge(days, now) + this.deps.pending.purge(days, now);
  }

  private async gatherSwap(intent: SwapIntent, route: Receipt["public"]["route"], tokens: TokenResponse[], agentQuote: QuoteResponse | undefined, g: Gathered, policy: Policy): Promise<void> {
    const { oneclick } = this.deps;
    // A quote handed in by the agent (or its tools) is evidence, never something we execute.
    if (agentQuote) {
      const sig = await checkQuoteSignature(agentQuote, this.deps.quoteManagerPublicKey);
      const r = checkQuote({ intent, policy, tokens, quote: agentQuote, signature: sig, expectDepositAddress: false });
      r.block.forEach((c) => g.block.add(c === "QUOTE_SIGNATURE_INVALID" ? "AGENT_QUOTE_FORGED" : `AGENT_${c}`));
    }
    const deadlineSec = Math.min(policy.maxDeadlineSec, 600);
    const req: QuoteRequest = {
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: policy.slippageToleranceBps,
      originAsset: intent.tokenIn,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: intent.tokenOut,
      amount: intent.amountIn,
      refundTo: intent.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: intent.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + deadlineSec * 1000).toISOString(),
      ...(route === "public" ? {} : { confidentiality: policy.confidentialLevel }),
    };
    try {
      g.dryQuote = await oneclick.quote(req);
      const sig = await checkQuoteSignature(g.dryQuote, this.deps.quoteManagerPublicKey);
      const r = checkQuote({ intent, policy, tokens, quote: g.dryQuote, signature: sig, expectDepositAddress: false });
      r.block.forEach((c) => g.block.add(c));
      r.warn.forEach((c) => g.review.add(c));
      g.metrics = r.metrics;
    } catch {
      g.block.add("QUOTE_UNAVAILABLE");
    }
    if (route !== "public" && g.dryQuote && g.block.size === 0) g.routeNote = await this.routeNote(req, g.dryQuote);
    // Live quote (carries the deposit address) only when nothing is blocked so far.
    if (g.dryQuote && g.block.size === 0) {
      try {
        const live = await oneclick.quote({ ...req, dry: false });
        const sig = await checkQuoteSignature(live, this.deps.quoteManagerPublicKey);
        const r = checkQuote({ intent, policy, tokens, quote: live, signature: sig, expectDepositAddress: true });
        r.block.forEach((c) => g.block.add(c));
        r.warn.forEach((c) => g.review.add(c));
        checkDryLiveDrift(g.dryQuote, live, policy).forEach((c) => g.block.add(c));
        g.metrics = r.metrics ?? g.metrics;
        g.quote = live;
        g.action = { kind: "swap", quote: live };
      } catch {
        g.block.add("QUOTE_UNAVAILABLE");
      }
    }
  }

  /** Told to the owner before a private route is signed. The cost comes from comparing two dry quotes. */
  private async routeNote(req: QuoteRequest, confidential: QuoteResponse): Promise<RouteNote> {
    const note: RouteNote = { hidden: ["the origin of the funds", "the route"], stillPublic: ["the destination and what it receives"] };
    try {
      const { confidentiality: _c, ...publicReq } = req;
      const pub = await this.deps.oneclick.quote(publicReq);
      const a = Number(pub.quote.minAmountOut);
      const b = Number(confidential.quote.minAmountOut);
      if (a > 0) note.extraCostBps = Math.round(((a - b) / a) * 10_000);
    } catch {
      /* the owner sees that the cost is unknown */
    }
    return note;
  }

  private reserve(agentId: string, cents: number) {
    return this.deps.ledger.reserve(agentId, cents, {
      hourlyCents: Math.round(this.deps.policy.hourlyUsd * 100),
      dailyCents: Math.round(this.deps.policy.dailyUsd * 100),
      maxPerHour: this.deps.policy.velocity.maxTxPerHour,
    });
  }

  /** Owner-only: accept a contract's current code after a COUNTERPARTY_CODE_CHANGED review. */
  async acceptCounterpartyCode(account: string, by: string): Promise<{ ok: boolean; codeHash?: string; details?: string }> {
    const info = await this.deps.counterparty.chain.account(account);
    if (!info?.isContract || !info.codeHash) return { ok: false, details: "account is not a contract or could not be read" };
    this.deps.counterparty.memory.acceptCodeHash(account, info.codeHash);
    this.deps.store.saveAudit(`code.${Date.now()}`, { account, codeHash: info.codeHash, acceptedBy: by, at: new Date().toISOString() });
    return { ok: true, codeHash: info.codeHash };
  }

  private async finish(args: {
    verdict: Verdict;
    block: string[];
    review: string[];
    intent?: DeclaredIntent;
    agentId: string;
    kind: string;
    route: Receipt["public"]["route"];
    receiptId?: string;
    quote?: QuoteResponse;
    live?: QuoteResponse;
    tee?: TeeEvidence;
    reservationId?: string;
    intentCommit?: { commitment: string; opening: Opening };
  }): Promise<Decision> {
    const q = args.quote;
    const sigOk = q ? (await checkQuoteSignature(q, this.deps.quoteManagerPublicKey)) === "valid" : false;
    const i = args.intent;
    const privateValues: Record<string, unknown> = { agentId: args.agentId };
    const limitDetail = args.block.filter((c) => LIMIT_CODES.has(c));
    if (limitDetail.length) privateValues.limitDetail = limitDetail;
    if (i) {
      privateValues.taskText = i.taskText;
      if (i.kind === "swap") Object.assign(privateValues, { tokenIn: i.tokenIn, tokenOut: i.tokenOut, amountIn: i.amountIn, minAmountOut: q?.quote.minAmountOut, recipient: i.recipient, refundTo: i.refundTo, depositAddress: args.live?.quote.depositAddress });
      else if (i.kind === "transfer") Object.assign(privateValues, { tokenIn: i.token, amountIn: i.amount, recipient: i.recipient });
      else if (i.kind === "call") Object.assign(privateValues, { contract: i.contract, method: i.method, args: i.args, amountIn: i.depositYocto });
      else Object.assign(privateValues, { details: i.details });
    }
    const { receipt, openings } = buildReceipt(
      {
        receiptId: args.receiptId,
        verdict: args.verdict,
        reasonCodes: publicCodes(args.block),
        warnCodes: args.review,
        publicPart: {
          intentKind: args.kind,
          route: args.route,
          mode: this.mode,
          network: this.deps.network,
          registeredAgent: this.deps.registryIdOf?.(args.agentId),
          quote: q ? { correlationId: q.correlationId, signatureVerified: sigOk, dry: !args.live } : undefined,
          budgetReservationId: args.reservationId,
        },
        privateValues,
        precommitted: args.intentCommit ? { intent: args.intentCommit } : undefined,
        policy: this.deps.policy,
        tee: args.tee,
      },
      this.deps.issuer,
    );
    const receiptPath = this.deps.store.save(receipt, openings);
    return {
      decisionId: receipt.receiptId,
      verdict: args.verdict,
      reasonCodes: receipt.reasonCodes,
      warnCodes: receipt.warnCodes ?? [],
      route: args.route,
      receiptPath,
      detailCodes: limitDetail.length ? limitDetail : undefined,
    };
  }

  /** A human approves a WARN decision. Callers must authenticate the human before calling this. */
  approve(decisionId: string, approver: string): { ok: boolean; details?: string } {
    const p = this.deps.pending.get(decisionId);
    if (!p) return { ok: false, details: "unknown, blocked or already executed decision" };
    if (p.verdict !== "WARN") return { ok: false, details: "decision does not need approval" };
    this.deps.pending.approve(decisionId, approver);
    this.deps.store.saveAudit(`${decisionId}.approval`, { decisionId, approvedBy: approver, at: new Date().toISOString() });
    return { ok: true };
  }

  /** A human rejects a WARN decision: budget is released immediately. */
  reject(decisionId: string, approver: string): { ok: boolean } {
    const p = this.deps.pending.take(decisionId);
    if (!p) return { ok: false };
    this.deps.ledger.release(p.reservationId);
    this.deps.store.saveAudit(`${decisionId}.approval`, { decisionId, rejectedBy: approver, at: new Date().toISOString() });
    return { ok: true };
  }

  /**
   * Execute an ALLOWed (or WARN + approved) decision. The budget stays spent unless the
   * executor says nothing left the wallet. If agentId is given it must match the decision.
   */
  async execute(decisionId: string, agentId?: string): Promise<ExecutionResult & { decisionId: string; executionReceiptId?: string }> {
    const peek = this.deps.pending.get(decisionId);
    if (!peek) return { decisionId, status: "not_sent", details: "unknown, blocked or already executed decision" };
    if (agentId !== undefined && peek.agentId !== agentId) return { decisionId, status: "not_sent", details: "decision belongs to another agent" };
    if (peek.verdict === "WARN" && !peek.approvedBy) return { decisionId, status: "not_sent", details: "WARN decision needs human approval first" };
    if (this.deps.freeze.state().frozen) return { decisionId, status: "not_sent", details: "wallet is frozen" };
    const p = this.deps.pending.take(decisionId);
    if (!p) return { decisionId, status: "not_sent", details: "already being executed" };

    if (p.action.kind === "swap") {
      const quote = p.action.quote;
      const deadline = Date.parse(quote.quote.deadline ?? quote.quoteRequest.deadline);
      if (Number.isFinite(deadline) && deadline < Date.now()) {
        this.deps.ledger.release(p.reservationId);
        return { decisionId, status: "not_sent", details: "quote expired; run preflight again" };
      }
      if ((await checkQuoteSignature(quote, this.deps.quoteManagerPublicKey)) !== "valid") {
        this.deps.ledger.release(p.reservationId);
        return { decisionId, status: "not_sent", details: "quote signature no longer verifies" };
      }
    }
    // a WARN that waited for a human may have outlived its reservation: re-check the budget
    if (!this.deps.ledger.commit(p.reservationId)) {
      const again = this.reserve(p.agentId, p.inCents);
      if (!again.ok) return { decisionId, status: "not_sent", details: again.reason };
      p.reservationId = again.reservationId;
      this.deps.ledger.commit(p.reservationId);
    }

    let result: ExecutionResult;
    this.deps.spendLog?.begin(decisionId);
    try {
      result = await this.deps.executor.execute(p.action, { idempotencyKey: decisionId });
    } catch (err) {
      result = { status: "unknown", details: (err as Error).message };
    }
    const hashes = result.txHashes ?? (result.txHash ? [result.txHash] : []);
    // an unknown outcome with no hash stays in flight: if a transaction shows up later it is reviewed, not assumed
    if (result.status !== "unknown" || hashes.length) this.deps.spendLog?.end(decisionId, hashes);
    const counterparty = p.action.kind === "call" ? p.action.contract : p.action.kind === "transfer" ? p.action.recipient : p.action.quote.quoteRequest.recipient;
    if (result.status === "not_sent" || result.status === "failed_on_chain") this.deps.ledger.uncommit(p.reservationId);
    else if (result.status !== "unknown") this.deps.counterparty.memory.recordInteraction(p.agentId, counterparty);
    const record = buildExecutionReceipt({ decisionId, kind: p.action.kind, status: result.status, txHash: result.txHash, txHashes: hashes.length > 1 ? hashes : undefined, network: this.deps.network, chain: result.chain, refusedByCustody: result.refusedByCustody, executedAt: new Date().toISOString(), approvedBy: p.approvedBy }, this.deps.issuer);
    this.deps.store.savePublic(record.receiptId, record);
    this.deps.store.saveAudit(`${decisionId}.execution`, { ...record, agentId: p.agentId, details: result.details });
    return { decisionId, ...result, executionReceiptId: record.receiptId };
  }
}
