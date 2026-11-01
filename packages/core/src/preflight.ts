import { buildReceipt, type IssuerKey, type Receipt, type TeeEvidence, type Verdict } from "@sealed-intent/receipt";
import { BudgetLedger } from "./budget";
import { checkCall, checkDryLiveDrift, checkQuote, checkTransfer, type QuoteMetrics } from "./checks";
import { assessCounterparty, type CounterpartyDeps } from "./counterparty";
import type { ExecutableAction, Executor, ExecutionResult } from "./executor";
import type { FreezeState, FreezeStore } from "./freeze";
import { scanTaskText } from "./injection";
import { AgentId, DeclaredIntent, type SwapIntent } from "./intent";
import type { OneClickClient, QuoteRequest, QuoteResponse, TokenResponse } from "./oneclick";
import type { PendingStore } from "./pending";
import type { Policy } from "./policy";
import { checkQuoteSignature } from "./quote-signature";
import type { ReceiptStore } from "./store";
import type { TeeChecker } from "./tee-check";

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
}

/** What the agent gets back. Deliberately thin: no thresholds, no amounts, no policy. */
export interface Decision {
  decisionId: string;
  verdict: Verdict;
  reasonCodes: string[];
  warnCodes: string[];
  route: Receipt["public"]["route"];
  receiptPath: string;
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
    this.deps.store.saveExecution(`freeze.${Date.now()}`, { frozen: true, reason, by, at: new Date().toISOString() });
  }

  unfreeze(by: string): boolean {
    const ok = this.deps.freeze.unfreeze();
    if (ok) this.deps.store.saveExecution(`freeze.${Date.now()}`, { frozen: false, by, at: new Date().toISOString() });
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
    const base = { agentId, intent, route };

    if (this.deps.freeze.state().frozen) {
      return this.finish({ ...base, verdict: "BLOCK", block: ["WALLET_FROZEN"], review: [], kind: intent.kind });
    }

    const executable = intent.kind === "swap" || intent.kind === "transfer" || intent.kind === "call";
    if (!executable || policy.actions.never.includes(intent.kind) || !policy.actions.allowed.includes(intent.kind)) {
      if (policy.freeze.onForbiddenAction) this.deps.freeze.freeze(`agent ${agentId} requested ${intent.kind}`, "auto");
      this.deps.freeze.recordBlock(agentId);
      return this.finish({ ...base, verdict: "BLOCK", block: ["ACTION_CLASS_FORBIDDEN"], review: [], kind: intent.kind });
    }
    if (intent.kind !== "swap" && intent.kind !== "transfer" && intent.kind !== "call") throw new Error("unreachable");

    const tokens = await this.deps.oneclick.getTokens();
    const g: Gathered = { block: new Set(), review: new Set() };
    let counterpartyAccount: string;
    if (intent.kind === "swap") {
      await this.gatherSwap(intent, route, tokens, input.agentQuote, g);
      counterpartyAccount = intent.recipient;
    } else if (intent.kind === "transfer") {
      const r = checkTransfer({ intent, policy, tokens });
      r.block.forEach((c) => g.block.add(c));
      g.metrics = r.metrics;
      g.action = { kind: "transfer", token: intent.token, recipient: intent.recipient, amount: intent.amount, memo: intent.memo };
      counterpartyAccount = intent.recipient;
    } else {
      const r = checkCall({ intent, policy, tokens });
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

    let tee: TeeEvidence | undefined;
    if (this.deps.tee) {
      try {
        tee = await this.deps.tee.check({ intent, quote: input.agentQuote ?? g.quote ?? g.dryQuote, policy, injectionCodes: scan.codes });
        if (tee.signal === "block") (policy.tee.obeyBlockSignal ? g.block : g.review).add("TEE_SIGNAL_BLOCK");
        if (tee.signal === "warn") g.review.add("TEE_SIGNAL_WARN");
      } catch {
        (policy.tee.required ? g.block : g.review).add("TEE_UNAVAILABLE");
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
    if (verdict === "BLOCK" && this.deps.freeze.recordBlock(agentId) >= policy.freeze.maxBlocksPerHour) {
      this.deps.freeze.freeze(`agent ${agentId} hit ${policy.freeze.maxBlocksPerHour} blocks in an hour`, "auto");
    }
    const decision = await this.finish({ ...base, verdict, block: [...g.block], review: [...g.review], kind: intent.kind, quote: g.quote ?? g.dryQuote, live: g.quote, tee, reservationId });
    if (verdict !== "BLOCK" && g.action && reservationId) {
      this.deps.pending.put({ decisionId: decision.decisionId, agentId, intent, action: g.action, reservationId, inCents, verdict, createdAt: Date.now() });
    }
    return { ...decision, metrics: g.metrics };
  }

  private async gatherSwap(intent: SwapIntent, route: Receipt["public"]["route"], tokens: TokenResponse[], agentQuote: QuoteResponse | undefined, g: Gathered): Promise<void> {
    const { policy, oneclick } = this.deps;
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

  private reserve(agentId: string, cents: number) {
    return this.deps.ledger.reserve(agentId, cents, {
      hourlyCents: Math.round(this.deps.policy.hourlyUsd * 100),
      dailyCents: Math.round(this.deps.policy.dailyUsd * 100),
    });
  }

  private async finish(args: {
    verdict: Verdict;
    block: string[];
    review: string[];
    intent?: DeclaredIntent;
    agentId: string;
    kind: string;
    route: Receipt["public"]["route"];
    quote?: QuoteResponse;
    live?: QuoteResponse;
    tee?: TeeEvidence;
    reservationId?: string;
  }): Promise<Decision> {
    const q = args.quote;
    const sigOk = q ? (await checkQuoteSignature(q, this.deps.quoteManagerPublicKey)) === "valid" : false;
    const i = args.intent;
    const privateValues: Record<string, unknown> = { agentId: args.agentId };
    if (i) {
      privateValues.taskText = i.taskText;
      if (i.kind === "swap") Object.assign(privateValues, { tokenIn: i.tokenIn, tokenOut: i.tokenOut, amountIn: i.amountIn, minAmountOut: q?.quote.minAmountOut, recipient: i.recipient, refundTo: i.refundTo, depositAddress: args.live?.quote.depositAddress });
      else if (i.kind === "transfer") Object.assign(privateValues, { tokenIn: i.token, amountIn: i.amount, recipient: i.recipient });
      else if (i.kind === "call") Object.assign(privateValues, { contract: i.contract, method: i.method, args: i.args, amountIn: i.depositYocto });
      else Object.assign(privateValues, { details: i.details });
    }
    const { receipt, openings } = buildReceipt(
      {
        verdict: args.verdict,
        reasonCodes: args.block,
        warnCodes: args.review,
        publicPart: {
          intentKind: args.kind,
          route: args.route,
          mode: this.mode,
          quote: q ? { correlationId: q.correlationId, signatureVerified: sigOk, dry: !args.live } : undefined,
          budgetReservationId: args.reservationId,
        },
        privateValues,
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
    };
  }

  /** A human approves a WARN decision. Callers must authenticate the human before calling this. */
  approve(decisionId: string, approver: string): { ok: boolean; details?: string } {
    const p = this.deps.pending.get(decisionId);
    if (!p) return { ok: false, details: "unknown, blocked or already executed decision" };
    if (p.verdict !== "WARN") return { ok: false, details: "decision does not need approval" };
    this.deps.pending.approve(decisionId, approver);
    this.deps.store.saveExecution(`${decisionId}.approval`, { decisionId, approvedBy: approver, at: new Date().toISOString() });
    return { ok: true };
  }

  /** A human rejects a WARN decision: budget is released immediately. */
  reject(decisionId: string, approver: string): { ok: boolean } {
    const p = this.deps.pending.take(decisionId);
    if (!p) return { ok: false };
    this.deps.ledger.release(p.reservationId);
    this.deps.store.saveExecution(`${decisionId}.approval`, { decisionId, rejectedBy: approver, at: new Date().toISOString() });
    return { ok: true };
  }

  /**
   * Execute an ALLOWed (or WARN + approved) decision. The budget stays spent unless the
   * executor says nothing left the wallet. If agentId is given it must match the decision.
   */
  async execute(decisionId: string, agentId?: string): Promise<ExecutionResult & { decisionId: string }> {
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
    try {
      result = await this.deps.executor.execute(p.action);
    } catch (err) {
      result = { status: "unknown", details: (err as Error).message };
    }
    const counterparty = p.action.kind === "call" ? p.action.contract : p.action.kind === "transfer" ? p.action.recipient : p.action.quote.quoteRequest.recipient;
    if (result.status === "not_sent") this.deps.ledger.uncommit(p.reservationId);
    else if (result.status !== "unknown") this.deps.counterparty.memory.recordInteraction(p.agentId, counterparty);
    this.deps.store.saveExecution(decisionId, { decisionId, agentId: p.agentId, kind: p.action.kind, at: new Date().toISOString(), approvedBy: p.approvedBy, ...result });
    return { decisionId, ...result };
  }
}
