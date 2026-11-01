import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetLedger, buildPreflight, DEMO_POLICY, FixtureOneClickClient, FIXTURE_TOKENS, type ChainReader, type ExecutableAction, type Executor, type ExecutionResult, type Policy } from "@sealed-intent/core";
import type { LedgerChain } from "./ledger";
import type { AgentAction } from "./scenario";
import { ACC, TOKENS } from "./world";

/**
 * A lane is one way of wiring the agent's wallet. All three receive the same requests.
 *   no-guard : the agent holds the key and signs whatever it decided
 *   caps-only: a spending cap per transaction and per day, nothing else (what most agent wallets ship)
 *   sealed   : every request goes through Sealed Intent; the agent holds no key
 */
export type LaneId = "no-guard" | "caps-only" | "sealed";

export interface LaneResult {
  lane: LaneId;
  phase?: "task" | "attack";
  verdict: "ALLOW" | "WARN" | "BLOCK";
  codes: string[];
  executed: boolean;
  error?: string;
  decisionId?: string;
  receiptPath?: string;
}

export interface Lane {
  readonly id: LaneId;
  readonly chain: LedgerChain;
  request(action: AgentAction, taskText?: string): Promise<LaneResult>;
  /** the referee's human stands in for the owner: approve WARNs by this rule */
  approver: (action: AgentAction, codes: string[]) => string | null;
}

function applyOnChain(chain: LedgerChain, action: AgentAction, haircutBps?: number): { ok: boolean; error?: string } {
  switch (action.kind) {
    case "transfer": {
      const r = chain.transfer(action.token!, ACC.agent, action.recipient!, BigInt(action.amount!), { memo: action.memo, yocto: true });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "swap": {
      const r = chain.swap(ACC.agent, action.token!, BigInt(action.amount!), action.tokenOut!, action.recipient ?? ACC.agent, haircutBps);
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "call":
      if (BigInt(action.depositYocto ?? "0") > 0n) chain.transfer(TOKENS_NEAR, ACC.agent, action.contract!, BigInt(action.depositYocto!));
      return { ok: true };
    case "add_key":
      chain.addKey(ACC.agent, action.publicKey!, "full");
      return { ok: true };
    case "deploy":
      chain.deploy(ACC.agent, action.codeHash ?? "sweeper");
      return { ok: true };
    case "sign_message":
      // a signed intents message lets the attacker move the balance held in intents.near
      if (action.recipient) chain.transfer(Object.keys(TOKENS)[0]!, ACC.agent, action.recipient, chain.balance(Object.keys(TOKENS)[0]!, ACC.agent) / 2n);
      return { ok: true };
  }
}
const TOKENS_NEAR = Object.keys(TOKENS)[1]!;

export class NoGuardLane implements Lane {
  readonly id = "no-guard" as const;
  haircutBps?: number;
  approver = () => "n/a";
  constructor(readonly chain: LedgerChain) {}
  async request(action: AgentAction): Promise<LaneResult> {
    const r = applyOnChain(this.chain, action, this.haircutBps);
    return { lane: this.id, verdict: "ALLOW", codes: [], executed: r.ok, error: r.error };
  }
}

/** Per-transaction and daily USD caps on a budget ledger, like a typical agent wallet. */
export class CapsOnlyLane implements Lane {
  readonly id = "caps-only" as const;
  haircutBps?: number;
  approver = () => "n/a";
  private ledger = new BudgetLedger(":memory:");
  constructor(readonly chain: LedgerChain, private readonly perTxUsd = DEMO_POLICY.perTxUsd, private readonly dailyUsd = DEMO_POLICY.dailyUsd) {}
  async request(action: AgentAction): Promise<LaneResult> {
    const usd = usdOf(action);
    if (usd > this.perTxUsd) return { lane: this.id, verdict: "BLOCK", codes: ["ABOVE_PER_TX_LIMIT"], executed: false };
    const res = this.ledger.reserve("agent", Math.ceil(usd * 100), { hourlyCents: Math.round(this.dailyUsd * 100), dailyCents: Math.round(this.dailyUsd * 100) });
    if (!res.ok) return { lane: this.id, verdict: "BLOCK", codes: [res.reason], executed: false };
    const r = applyOnChain(this.chain, action, this.haircutBps);
    if (r.ok) this.ledger.commit(res.reservationId);
    else this.ledger.release(res.reservationId);
    return { lane: this.id, verdict: "ALLOW", codes: [], executed: r.ok, error: r.error };
  }
}

function usdOf(action: AgentAction): number {
  if (action.kind === "transfer" || action.kind === "swap") {
    const t = TOKENS[action.token!];
    return t ? (Number(action.amount) / 10 ** t.decimals) * t.priceUsd : 0;
  }
  if (action.kind === "call") return (Number(action.depositYocto ?? 0) / 1e24) * TOKENS[TOKENS_NEAR]!.priceUsd;
  return 0;
}

/** Executes ALLOWed decisions on the arena ledger instead of OutLayer. */
class LedgerExecutor implements Executor {
  readonly mode = "offline" as const;
  constructor(private readonly chain: LedgerChain, private readonly lane: SealedLane) {}
  async execute(a: ExecutableAction): Promise<ExecutionResult> {
    const action: AgentAction =
      a.kind === "swap"
        ? { kind: "swap", token: a.quote.quoteRequest.originAsset, tokenOut: a.quote.quoteRequest.destinationAsset, amount: a.quote.quote.amountIn, recipient: a.quote.quoteRequest.recipient }
        : a.kind === "transfer"
          ? { kind: "transfer", token: a.token, amount: a.amount, recipient: a.recipient, memo: a.memo }
          : { kind: "call", contract: a.contract, method: a.method, depositYocto: a.depositYocto };
    const r = applyOnChain(this.chain, action, this.lane.haircutBps);
    return r.ok ? { status: "simulated", txHash: `ledger-${this.chain.blockHeight()}` } : { status: "not_sent", details: r.error };
  }
}

/** The chain reader Sealed Intent sees. It can be made to lie for the Lying RPC scenario. */
class ArenaChainReader implements ChainReader {
  lies = new Map<string, string>();
  constructor(private readonly chain: LedgerChain) {}
  async account(id: string) {
    const real = await this.chain.account(id);
    const lie = this.lies.get(id);
    return real && lie ? { ...real, codeHash: lie } : real;
  }
}

export class SealedLane implements Lane {
  readonly id = "sealed" as const;
  haircutBps?: number;
  readonly reader: ArenaChainReader;
  readonly oneclick = new FixtureOneClickClient(FIXTURE_TOKENS);
  readonly env;
  approver: Lane["approver"];

  constructor(readonly chain: LedgerChain, policy: Policy, approver: Lane["approver"], home = mkdtempSync(join(tmpdir(), "arena-sealed-"))) {
    this.reader = new ArenaChainReader(chain);
    this.approver = approver;
    this.env = buildPreflight({ offline: true, home: join(home, ".sealed"), outDir: join(home, "out"), ledgerPath: ":memory:", policy, chain: this.reader, oneclick: this.oneclick, executor: new LedgerExecutor(chain, this) });
    for (const acc of [ACC.vault]) this.env.memory.swapCodeHash(acc, chain.codeHash(acc) ?? "");
  }

  async request(action: AgentAction, taskText?: string): Promise<LaneResult> {
    this.oneclick.behavior = { minOutHaircutBps: this.haircutBps ?? 0 };
    const intent = toIntent(action, taskText);
    const d = await this.env.preflight.evaluate({ agentId: "agent", intent });
    const base = { lane: this.id, verdict: d.verdict, codes: [...d.reasonCodes, ...d.warnCodes], decisionId: d.decisionId, receiptPath: d.receiptPath };
    if (d.verdict === "BLOCK") return { ...base, executed: false };
    if (d.verdict === "WARN") {
      const who = this.approver(action, d.warnCodes);
      if (!who) {
        this.env.preflight.reject(d.decisionId, "human");
        return { ...base, executed: false, error: "rejected by human" };
      }
      this.env.preflight.approve(d.decisionId, who);
    }
    const x = await this.env.preflight.execute(d.decisionId, "agent");
    return { ...base, executed: x.status !== "not_sent", error: x.status === "not_sent" ? String(x.details) : undefined };
  }
}

function toIntent(a: AgentAction, taskText?: string): unknown {
  const common = { purpose: a.purpose ?? "general", taskText };
  switch (a.kind) {
    case "transfer":
      return { kind: "transfer", token: a.token, amount: a.amount, recipient: a.recipient, memo: a.memo, ...common };
    case "swap":
      return { kind: "swap", tokenIn: a.token, tokenOut: a.tokenOut, amountIn: a.amount, recipient: a.recipient ?? ACC.agent, refundTo: ACC.agent, ...common };
    case "call":
      return { kind: "call", contract: a.contract, method: a.method, args: {}, depositYocto: a.depositYocto ?? "0", ...common };
    default:
      return { kind: a.kind, details: { publicKey: a.publicKey, codeHash: a.codeHash, message: a.message, recipient: a.recipient }, ...common };
  }
}
