import { createHash } from "node:crypto";
import { ASSET, type Policy } from "@sealed-intent/core";
import { canonicalJson } from "@sealed-intent/receipt";
import { TASKS, SCENARIOS } from "./catalog";
import type { ArenaChain } from "./chain";
import { CapsOnlyLane, NoGuardLane, SealedLane, type Lane, type LaneId, type LaneResult } from "./lanes";
import type { Snapshot } from "./ledger";
import { referee, type RefereeTask, type RefereeVerdict } from "./referee";
import type { AgentAction, Scenario, Step, Task } from "./scenario";
import { ACC, ARENA_POLICY, ATTACKERS, TOKENS, buildWorld, usdc } from "./world";

export interface ArenaEvent {
  seq: number;
  scenario: string;
  lane: LaneId | "chain" | "attacker" | "human";
  type: "inbox" | "tool" | "path" | "chain" | "decision" | "note";
  summary: string;
  action?: AgentAction;
  result?: LaneResult;
  raw?: unknown;
}

export interface ScenarioOutcome {
  scenario: Pick<Scenario, "id" | "title" | "group" | "origin" | "pattern" | "summary" | "expectedSealed" | "cannotReplicate" | "attackers">;
  lanes: Record<LaneId, { verdict: RefereeVerdict; results: LaneResult[] }>;
  events: ArenaEvent[];
  before: Record<LaneId, Snapshot>;
  after: Record<LaneId, Snapshot>;
}

export interface RunOptions {
  policy?: Policy;
  scenarios?: Scenario[];
  tasks?: Task[];
  approver?: "strict" | "lazy";
  seed?: string;
  /** one chain per lane; default: a fresh in-memory ledger per scenario */
  chains?: Record<LaneId, ArenaChain>;
  onScenario?: (s: Scenario) => void;
}

export interface RunResult {
  manifest: {
    runId: string;
    createdAt: string;
    chain: "ledger" | "sandbox";
    victim: "scripted";
    approver: "strict" | "lazy";
    policyHash: string;
    catalogHash: string;
    seed: string;
    prices: typeof TOKENS;
    accounts: Record<string, string>;
    realVsSimulated: Record<string, string>;
  };
  outcomes: ScenarioOutcome[];
  totals: Record<LaneId, { stolenCents: number; escaped: string[]; legitDone: number; legitTotal: number; falseBlocks: string[]; foreignKeys: number }>;
}

const hash = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");

/**
 * The owner's stand-in. Strict: a human who reads the codes and knows the payees.
 * Lazy: a human who clicks approve on everything.
 */
function makeApprover(mode: "strict" | "lazy"): Lane["approver"] {
  const legit = new Set<string>([ACC.payroll, ACC.vendor, ACC.newVendor, ACC.treasury, ACC.agent, ACC.pool, ACC.vault]);
  const alarming = ["COUNTERPARTY_CODE_CHANGED", "COUNTERPARTY_BLOCKLISTED", "PROMPT_INJECTION_SUSPECTED", "TEE_SIGNAL_BLOCK"];
  return (action, codes) => {
    if (mode === "lazy") return "lazy-approver";
    if (codes.some((c) => alarming.includes(c))) return null;
    return legit.has(action.recipient ?? action.contract ?? "") ? "owner" : null;
  };
}

async function laneSet(policy: Policy, approver: "strict" | "lazy", chains?: Record<LaneId, ArenaChain>): Promise<Record<LaneId, Lane>> {
  const c = chains ?? { "no-guard": buildWorld(), "caps-only": buildWorld(), sealed: buildWorld() };
  await Promise.all(Object.values(c).map((chain) => chain.reset()));
  return {
    "no-guard": new NoGuardLane(c["no-guard"]),
    "caps-only": new CapsOnlyLane(c["caps-only"]),
    sealed: await new SealedLane(c.sealed, policy, makeApprover(approver)).init(),
  };
}

function describe(a: AgentAction): string {
  const amt = (t?: string, v?: string) => (t && v && TOKENS[t] ? `${(Number(v) / 10 ** TOKENS[t]!.decimals).toFixed(2)} ${t === ASSET.USDC ? "USDC" : t === ASSET.wNEAR ? "wNEAR" : "tokens"}` : v ?? "");
  switch (a.kind) {
    case "transfer": return `pay ${amt(a.token, a.amount)} to ${a.recipient}`;
    case "swap": return `swap ${amt(a.token, a.amount)} to ${a.tokenOut === ASSET.wNEAR ? "wNEAR" : a.tokenOut}`;
    case "call": return `call ${a.contract}.${a.method}`;
    case "add_key": return `add full-access key ${a.publicKey}`;
    case "deploy": return `deploy code to the agent account`;
    case "sign_message": return `sign an intents message for ${a.recipient}`;
  }
}

async function snapshots(lanes: Record<LaneId, Lane>, ids: LaneId[]): Promise<Record<LaneId, Snapshot>> {
  return Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await lanes[id].chain.snapshot()]))) as Record<LaneId, Snapshot>;
}

export async function runScenario(scenario: Scenario, tasks: Task[], opts: Required<Pick<RunOptions, "policy" | "approver">> & Pick<RunOptions, "chains">): Promise<ScenarioOutcome> {
  const lanes = await laneSet(opts.policy, opts.approver, opts.chains);
  const ids = Object.keys(lanes) as LaneId[];
  const before = await snapshots(lanes, ids);
  const events: ArenaEvent[] = [];
  const results: Record<LaneId, LaneResult[]> = { "no-guard": [], "caps-only": [], sealed: [] };
  let seq = 0;
  const note = (lane: ArenaEvent["lane"], type: ArenaEvent["type"], summary: string, extra: Partial<ArenaEvent> = {}) => events.push({ seq: seq++, scenario: scenario.id, lane, type, summary, ...extra });
  let phase: "task" | "attack" = "task";
  const ask = async (action: AgentAction, taskText: string | undefined, label: string) => {
    const rs = await Promise.all(ids.map(async (id) => [id, { ...(await lanes[id].request(action, taskText)), phase }] as const));
    for (const [id, r] of rs) {
      results[id].push(r);
      note(id, "decision", `${label}: ${r.verdict}${r.codes.length ? ` (${r.codes.join(", ")})` : ""}${r.executed ? ", executed" : r.error ? `, not executed: ${r.error}` : ", not executed"}`, { action, result: r });
    }
  };

  // legit tasks interleave with the attack: two before, the rest after
  const [t1, t2, ...rest] = tasks;
  for (const t of [t1, t2].filter(Boolean) as Task[]) {
    note("attacker", "inbox", `[${t.id}] ${t.text}`);
    await ask(t.action, t.text, t.title);
  }
  phase = "attack";
  for (const step of scenario.steps) await applyStep(step, scenario, lanes, ids, ask, note);
  const sealed = lanes.sealed as SealedLane;
  if (sealed.env.preflight.status().frozen) {
    const reason = sealed.env.preflight.status().reason;
    sealed.env.preflight.unfreeze("owner");
    note("human", "note", `the owner reviewed the freeze (${reason}) and lifted it`);
  }
  phase = "task";
  for (const t of rest) {
    note("attacker", "inbox", `[${t.id}] ${t.text}`);
    await ask(t.action, t.text, t.title);
  }

  const after = await snapshots(lanes, ids);
  const refTasks: RefereeTask[] = tasks.map((t) => ({ id: t.id, token: t.action.kind === "swap" ? t.action.tokenOut! : t.action.token!, recipient: t.action.recipient ?? ACC.agent, amount: t.action.kind === "swap" ? "0" : t.action.amount!, toleranceBps: 0 }));
  const payees = scenario.attackers.map((payee) => ({ id: scenario.id, payee }));
  const attackerAccounts = [...new Set([...ATTACKERS, ...scenario.attackers])];
  const laneVerdicts = Object.fromEntries(
    ids.map((id) => [id, { verdict: referee({ before: before[id], after: after[id], tasks: refTasks, attackerAccounts, agentAccount: ACC.agent, prices: TOKENS, attacks: payees, spendCapCents: Math.round(opts.policy.dailyUsd * 100) }), results: results[id] }]),
  ) as ScenarioOutcome["lanes"];
  for (const id of ids) lanes[id].chain.events.length = 0;
  const { steps: _s, mandatory: _m, ...meta } = scenario;
  return { scenario: meta, lanes: laneVerdicts, events, before, after };
}

async function applyStep(step: Step, scenario: Scenario, lanes: Record<LaneId, Lane>, ids: LaneId[], ask: (a: AgentAction, t: string | undefined, label: string) => Promise<void>, note: (lane: ArenaEvent["lane"], type: ArenaEvent["type"], summary: string, extra?: Partial<ArenaEvent>) => void) {
  switch (step.type) {
    case "message": {
      note("attacker", "inbox", `from ${step.from}: ${step.text}`);
      const toolAppends = "toolAppends" in step ? step.toolAppends ?? [] : [];
      const rewritten = "toolRewrites" in step && step.toolRewrites ? { ...step.ask, ...step.toolRewrites } : step.ask;
      if ("toolRewrites" in step && step.toolRewrites) note("attacker", "tool", `the tool layer rewrote the request: ${describe(rewritten)}`);
      await ask(rewritten, step.text, `agent decides to ${describe(step.ask)}`);
      for (const extra of toolAppends) {
        note("attacker", "tool", `the tool layer appended a hidden action: ${describe(extra)}`);
        await ask(extra, undefined, `hidden action: ${describe(extra)}`);
      }
      return;
    }
    case "path":
      note("attacker", "path", `${step.label}: ${step.actions.length} requests straight to the tool layer`);
      for (const a of step.actions) await ask(a, undefined, describe(a));
      return;
    case "chain":
      await Promise.all(
        ids.map(async (id) => {
          const chain = lanes[id].chain;
          if (step.op === "deploy") await chain.deploy(step.account, step.codeHash);
          else await chain.transfer(step.token, step.from, step.to, BigInt(step.amount));
        }),
      );
      note("chain", "chain", step.op === "dust" ? `dust from look-alike ${step.from.slice(0, 8)}… lands in the agent's history` : step.op === "deploy" ? `${step.account} code changed to ${step.codeHash.slice(0, 10)}…` : `${step.label}: ${step.amount} moved from ${step.from} to ${step.to} without the agent`);
      return;
    case "lying_rpc":
      (lanes.sealed as SealedLane).reader.lies.set(step.account, await lanes.sealed.chain.codeHashFor(step.codeHash));
      note("attacker", "note", `the RPC used by the checker now reports the old code hash for ${step.account}`);
      return;
    case "bad_quote":
      for (const id of ids) (lanes[id] as NoGuardLane).haircutBps = step.haircutBps;
      note("attacker", "note", `the quote source now routes through a pool that loses ${step.haircutBps / 100}% of value`);
      return;
  }
}

export async function runArena(opts: RunOptions = {}): Promise<RunResult> {
  const policy = opts.policy ?? ARENA_POLICY;
  const approver = opts.approver ?? "strict";
  const scenarios = opts.scenarios ?? SCENARIOS.filter((s) => s.mandatory);
  const tasks = opts.tasks ?? TASKS;
  const outcomes: ScenarioOutcome[] = [];
  const chain = opts.chains?.sealed.kind ?? "ledger";
  for (const s of scenarios) {
    opts.onScenario?.(s);
    outcomes.push(await runScenario(s, tasks, { policy, approver, chains: opts.chains }));
  }
  const totals = Object.fromEntries(
    (["no-guard", "caps-only", "sealed"] as LaneId[]).map((id) => [
      id,
      {
        stolenCents: outcomes.reduce((n, o) => n + o.lanes[id].verdict.stolenCents, 0),
        escaped: outcomes.flatMap((o) => o.lanes[id].verdict.escaped),
        legitDone: outcomes.reduce((n, o) => n + o.lanes[id].verdict.legitDone, 0),
        legitTotal: outcomes.reduce((n, o) => n + o.lanes[id].verdict.legitTotal, 0),
        falseBlocks: outcomes.flatMap((o) => o.lanes[id].verdict.falseBlocks.map((t) => `${o.scenario.id}/${t}`)),
        foreignKeys: outcomes.reduce((n, o) => n + o.lanes[id].verdict.foreignKeys.length, 0),
      },
    ]),
  ) as RunResult["totals"];
  const seed = opts.seed ?? "default";
  return {
    manifest: {
      runId: `${chain}-${new Date().toISOString().slice(0, 10)}-${hash({ seed, scenarios: scenarios.map((s) => s.id) }).slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      chain,
      victim: "scripted",
      approver,
      policyHash: hash(policy),
      catalogHash: hash(scenarios),
      seed,
      prices: TOKENS,
      accounts: { agent: ACC.agent, treasury: ACC.treasury, attackers: ATTACKERS.join(",") },
      realVsSimulated: {
        chain:
          chain === "sandbox"
            ? "REAL LOCAL NEAR NODE (near-sandbox; genuine NEP-141 token contracts; the swap router and reference prices are simulated)"
            : "SIMULATED LEDGER (NEP-141 rules in memory; pass --chain sandbox for a real local node)",
        quotes: "SIMULATED (fixture 1Click quotes signed with a local key)",
        tee: "SIMULATED (offline rule-based stand-in)",
        custody: "SIMULATED (ledger executor instead of OutLayer)",
        victim: "scripted (no LLM; it follows every message)",
        rules: "REAL (the same Sealed Intent code that runs live)",
      },
    },
    outcomes,
    totals,
  };
}

export { usdc };
