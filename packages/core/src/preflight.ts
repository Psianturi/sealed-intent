import { buildReceipt, type IssuerKey, type Receipt, type TeeEvidence, type Verdict } from "@sealed-intent/receipt";
import { BudgetLedger } from "./budget";
import { checkDryLiveDrift, checkQuote, type QuoteMetrics } from "./checks";
import { assessCounterparty, type CounterpartyDeps } from "./counterparty";
import type { Executor, ExecutionResult } from "./executor";
import { scanTaskText } from "./injection";
import { DeclaredIntent } from "./intent";
import type { OneClickClient, QuoteRequest, QuoteResponse } from "./oneclick";
import type { Policy } from "./policy";
import { checkQuoteSignature } from "./quote-signature";
import type { ReceiptStore } from "./store";
import type { TeeChecker } from "./tee-check";

export interface PreflightDeps {
  oneclick: OneClickClient;
  policy: Policy;
  ledger: BudgetLedger;
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
  /** why it was blocked */
  reasonCodes: string[];
  /** why a human must look at it (WARN) */
  warnCodes: string[];
  route: Receipt["public"]["route"];
  receiptPath: string;
}

interface Pending {
  intent: DeclaredIntent;
  live: QuoteResponse;
  reservationId: string;
  inCents: number;
  verdict: "ALLOW" | "WARN";
  approvedBy?: string;
}

export class Preflight {
  private pending = new Map<string, Pending>();

  constructor(private readonly deps: PreflightDeps) {}

  get mode(): "live" | "offline" {
    return this.deps.oneclick.mode;
  }

  get policy(): Policy {
    return this.deps.policy;
  }

  async evaluate(input: { intent: unknown; agentQuote?: QuoteResponse }): Promise<Decision & { metrics?: QuoteMetrics }> {
    const { policy, oneclick } = this.deps;
    const block = new Set<string>();
    const review = new Set<string>();
    const notes: string[] = [];

    const parsed = DeclaredIntent.safeParse(input.intent);
    if (!parsed.success) {
      return this.finish({ verdict: "BLOCK", block: ["INVALID_INTENT"], review: [], route: "public" });
    }
    const intent = parsed.data;
    const tokens = await oneclick.getTokens();
    const route: Receipt["public"]["route"] = policy.privatePurposes.includes(intent.purpose) ? `confidential-${policy.confidentialLevel}` : "public";

    // A quote handed in by the agent (or its tools) is evidence, never something we execute.
    if (input.agentQuote) {
      const sig = await checkQuoteSignature(input.agentQuote, this.deps.quoteManagerPublicKey);
      const r = checkQuote({ intent, policy, tokens, quote: input.agentQuote, signature: sig, expectDepositAddress: false });
      r.block.forEach((c) => block.add(c === "QUOTE_SIGNATURE_INVALID" ? "AGENT_QUOTE_FORGED" : `AGENT_${c}`));
    }

    // Our own dry quote, built from the declared intent only.
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

    let dry: QuoteResponse | undefined;
    let live: QuoteResponse | undefined;
    let metrics: QuoteMetrics | undefined;
    try {
      dry = await oneclick.quote(req);
      const sig = await checkQuoteSignature(dry, this.deps.quoteManagerPublicKey);
      const r = checkQuote({ intent, policy, tokens, quote: dry, signature: sig, expectDepositAddress: false });
      r.block.forEach((c) => block.add(c));
      r.warn.forEach((c) => review.add(c));
      metrics = r.metrics;
    } catch (err) {
      block.add("QUOTE_UNAVAILABLE");
      notes.push(`quote error: ${(err as Error).message}`);
    }

    // Who receives the money
    const cp = await assessCounterparty({ agentId: intent.agentId, account: intent.recipient, policy }, this.deps.counterparty);
    cp.block.forEach((c) => block.add(c));
    cp.review.forEach((c) => review.add(c));

    // Untrusted task text
    const scan = scanTaskText(intent.taskText, [...policy.allowedRecipients, ...policy.ownAccounts, intent.recipient, intent.refundTo]);
    if (scan.codes.length) (policy.injection.block ? block : review).add("PROMPT_INJECTION_SUSPECTED");

    // Live quote (carries the deposit address) only when nothing is blocked so far.
    if (dry && block.size === 0) {
      try {
        live = await oneclick.quote({ ...req, dry: false });
        const sig = await checkQuoteSignature(live, this.deps.quoteManagerPublicKey);
        const r = checkQuote({ intent, policy, tokens, quote: live, signature: sig, expectDepositAddress: true });
        r.block.forEach((c) => block.add(c));
        r.warn.forEach((c) => review.add(c));
        checkDryLiveDrift(dry, live, policy).forEach((c) => block.add(c));
        metrics = r.metrics ?? metrics;
      } catch (err) {
        block.add("QUOTE_UNAVAILABLE");
        notes.push(`live quote error: ${(err as Error).message}`);
      }
    }

    // Private second opinion inside a TEE
    let tee: TeeEvidence | undefined;
    const quoteForTee = input.agentQuote ?? live ?? dry;
    if (this.deps.tee && quoteForTee) {
      try {
        tee = await this.deps.tee.check({ intent, quote: quoteForTee, policy, injectionCodes: scan.codes });
        if (tee.signal === "block") (policy.tee.obeyBlockSignal ? block : review).add("TEE_SIGNAL_BLOCK");
        if (tee.signal === "warn") review.add("TEE_SIGNAL_WARN");
      } catch (err) {
        (policy.tee.required ? block : review).add("TEE_UNAVAILABLE");
        notes.push(`tee error: ${(err as Error).message}`);
      }
    } else if (policy.tee.required) {
      block.add("TEE_UNAVAILABLE");
    }

    // Atomic budget reservation: the last gate. WARN decisions hold budget while a human decides.
    let reservationId: string | undefined;
    const inCents = metrics ? Math.ceil(metrics.inUsd * 100) : 0;
    if (block.size === 0 && metrics) {
      const res = this.reserve(intent.agentId, inCents);
      if (res.ok) reservationId = res.reservationId;
      else block.add(res.reason);
    }

    const verdict: Verdict = block.size ? "BLOCK" : review.size ? "WARN" : "ALLOW";
    const decision = await this.finish({ verdict, block: [...block], review: [...review], intent, route, dry, live, tee, reservationId });
    if (verdict !== "BLOCK" && live && reservationId) {
      this.pending.set(decision.decisionId, { intent, live, reservationId, inCents, verdict });
    }
    return { ...decision, metrics };
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
    route: Receipt["public"]["route"];
    dry?: QuoteResponse;
    live?: QuoteResponse;
    tee?: TeeEvidence;
    reservationId?: string;
  }): Promise<Decision> {
    const q = args.live ?? args.dry;
    const sigOk = q ? (await checkQuoteSignature(q, this.deps.quoteManagerPublicKey)) === "valid" : false;
    const { receipt, openings } = buildReceipt(
      {
        verdict: args.verdict,
        reasonCodes: args.block,
        warnCodes: args.review,
        publicPart: {
          intentKind: "swap",
          route: args.route,
          mode: this.mode,
          quote: q ? { correlationId: q.correlationId, signatureVerified: sigOk, dry: !args.live } : undefined,
          budgetReservationId: args.reservationId,
        },
        privateValues: args.intent
          ? {
              agentId: args.intent.agentId,
              tokenIn: args.intent.tokenIn,
              tokenOut: args.intent.tokenOut,
              amountIn: args.intent.amountIn,
              minAmountOut: q?.quote.minAmountOut,
              recipient: args.intent.recipient,
              refundTo: args.intent.refundTo,
              depositAddress: args.live?.quote.depositAddress,
              taskText: args.intent.taskText,
            }
          : {},
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

  /** A human approves a WARN decision. The approval is logged next to the receipt. */
  approve(decisionId: string, approver: string): { ok: boolean; details?: string } {
    const p = this.pending.get(decisionId);
    if (!p) return { ok: false, details: "unknown, blocked or already executed decision" };
    if (p.verdict !== "WARN") return { ok: false, details: "decision does not need approval" };
    p.approvedBy = approver;
    this.deps.store.saveExecution(`${decisionId}.approval`, { decisionId, approvedBy: approver, at: new Date().toISOString() });
    return { ok: true };
  }

  /** A human rejects a WARN decision: budget is released immediately. */
  reject(decisionId: string, approver: string): { ok: boolean } {
    const p = this.pending.get(decisionId);
    if (!p) return { ok: false };
    this.pending.delete(decisionId);
    this.deps.ledger.release(p.reservationId);
    this.deps.store.saveExecution(`${decisionId}.approval`, { decisionId, rejectedBy: approver, at: new Date().toISOString() });
    return { ok: true };
  }

  /** Execute an ALLOWed (or WARN + approved) decision. Budget is committed on success, released on failure. */
  async execute(decisionId: string): Promise<ExecutionResult & { decisionId: string }> {
    const p = this.pending.get(decisionId);
    if (!p) return { decisionId, status: "failed", details: "unknown, blocked or already executed decision" };
    if (p.verdict === "WARN" && !p.approvedBy) return { decisionId, status: "failed", details: "WARN decision needs human approval first" };
    this.pending.delete(decisionId);
    const deadline = Date.parse(p.live.quote.deadline ?? p.live.quoteRequest.deadline);
    if (Number.isFinite(deadline) && deadline < Date.now()) {
      this.deps.ledger.release(p.reservationId);
      return { decisionId, status: "failed", details: "quote expired; run preflight again" };
    }
    if ((await checkQuoteSignature(p.live, this.deps.quoteManagerPublicKey)) !== "valid") {
      this.deps.ledger.release(p.reservationId);
      return { decisionId, status: "failed", details: "quote signature no longer verifies" };
    }
    // a WARN that waited for a human may have outlived its reservation: re-check the budget
    if (!this.deps.ledger.commit(p.reservationId)) {
      const again = this.reserve(p.intent.agentId, p.inCents);
      if (!again.ok) return { decisionId, status: "failed", details: again.reason };
      p.reservationId = again.reservationId;
      this.deps.ledger.commit(p.reservationId);
    }
    try {
      const result = await this.deps.executor.execute(p.live);
      if (result.status === "failed") this.deps.ledger.uncommit(p.reservationId);
      else this.deps.counterparty.memory.recordInteraction(p.intent.agentId, p.intent.recipient);
      this.deps.store.saveExecution(decisionId, { decisionId, at: new Date().toISOString(), approvedBy: p.approvedBy, ...result });
      return { decisionId, ...result };
    } catch (err) {
      this.deps.ledger.uncommit(p.reservationId);
      return { decisionId, status: "failed", details: (err as Error).message };
    }
  }
}
