// Turns an official recording into what the Arena stage shows. The stage reads nothing else, so every
// number and every gate it lights up comes from the recording. Pure: used by the browser, the build and the tests.
import { LANES, usd, type ArenaEvent, type LaneId, type LaneResult, type Outcome, type Run } from "./arena-data";

export const GATE_NAMES = ["Deal real?", "Who gets it?", "A payment?", "Tricked?", "In budget?"] as const;

/** pass and warn: the check ran. fail: it stopped the request. not_run: it never ran. bypassed: the request went around every check. */
export type GateStatus = "pass" | "warn" | "fail" | "not_run" | "bypassed";
export interface Gate {
  status: GateStatus;
  codes: string[];
  /** the money got this far; an unreached gate stays dark whatever its status */
  reached: boolean;
}

export type LaneOutcome = "lost" | "key" | "stopped" | "owner-rejected" | "owner-approved" | "delivered" | "untouched";
export interface LaneStory {
  outcome: LaneOutcome;
  lostCents: number;
  keysAdded: number;
  requests: number;
  gates: Gate[];
  /** index of the gate where the money stopped or waited for the owner */
  stopAt: number | null;
  owner?: "approved" | "rejected";
  codes: string[];
}

export type Moment =
  | { kind: "message" }
  | { kind: "address-diff"; real: string; fake: string }
  | { kind: "budget-gauge"; sharePct: number }
  | { kind: "price-gap"; lossPct: number }
  | { kind: "key-xray" }
  | { kind: "signature" }
  | { kind: "burst"; count: number }
  | { kind: "bypass"; how: string }
  | { kind: "none" };

export interface StoryCase {
  id: string;
  title: string;
  kind: "attack" | "everyday";
  group: string;
  outOfScope: boolean;
  pattern?: { incident: string; date: string; source: string };
  summary: string;
  message?: { from: string; text: string; highlights: [number, number][] };
  /** what the agent decided, in one line */
  ask: { what: string; label: string; form: "money" | "key" | "signature"; cents: number };
  destination: { name: string; attacker: boolean };
  lanes: Record<LaneId, LaneStory>;
  moment: Moment;
  receipt?: { decisionId: string; verdict: string; codes: string[]; warnCodes: string[] };
}

export interface Storyboard {
  runId: string;
  dir: string;
  approver: string;
  chain: string;
  createdAt: string;
  featured: string[];
  cases: StoryCase[];
  totals: Record<LaneId, { lostIn: number; lostOut: number; stoppedIn: number; inScope: number; outOfScope: number; legitDone: number; legitTotal: number; falseBlocks: number }>;
}

const GATE_OF: [RegExp, number][] = [
  [/QUOTE|ASSET|VALUE_LOSS|DRIFT|ROUTE|NO_REFERENCE_PRICE/, 0],
  [/COUNTERPARTY|RECIPIENT|RPC_DISAGREEMENT/, 1],
  [/ACTION_CLASS|METHOD|CONTRACT|FROZEN|DEPOSIT/, 2],
  [/INJECTION|TEE|TASK_CONTEXT/, 3],
  [/LIMIT|BUDGET|RATE/, 4],
];
export const gateOf = (code: string): number => GATE_OF.find(([re]) => re.test(code))?.[1] ?? 4;

const attacks = (o: Outcome, l: LaneId) => o.lanes[l].results.filter((r) => r.phase === "attack");

/** The request that decided the lane: the first one stopped or held, else the first one. */
function decisive(results: LaneResult[]): LaneResult | undefined {
  return results.find((r) => r.verdict === "BLOCK") ?? results.find((r) => r.verdict === "WARN" && !r.executed) ?? results.find((r) => r.verdict === "WARN") ?? results[0];
}

export function sealedGates(r: LaneResult | undefined): { gates: Gate[]; stopAt: number | null } {
  if (!r) return { gates: GATE_NAMES.map(() => ({ status: "bypassed", codes: [], reached: false })), stopAt: null };
  const warn = new Set(r.warnCodes ?? (r.verdict === "WARN" ? r.codes : []));
  const block = r.codes.filter((c) => !warn.has(c));
  const byGate = (list: Iterable<string>, g: number) => [...list].filter((c) => gateOf(c) === g);
  // a forbidden action or a frozen wallet returns before any other check runs
  const early = block.some((c) => /ACTION_CLASS|FROZEN/.test(c));
  const gates: Gate[] = GATE_NAMES.map((_, g) => {
    const b = byGate(block, g);
    const w = byGate(warn, g);
    if (early && g !== 2) return { status: "not_run", codes: [], reached: false };
    // the budget is only reserved when nothing else blocked
    if (g === 4 && r.verdict === "BLOCK" && b.length === 0) return { status: "not_run", codes: [], reached: false };
    return { status: b.length ? "fail" : w.length ? "warn" : "pass", codes: [...b, ...w], reached: false };
  });
  const firstFail = gates.findIndex((x) => x.status === "fail");
  const firstWarn = gates.findIndex((x) => x.status === "warn");
  const stopAt = r.verdict === "BLOCK" ? (firstFail >= 0 ? firstFail : null) : r.verdict === "WARN" && !r.executed ? (firstWarn >= 0 ? firstWarn : null) : null;
  const end = stopAt ?? gates.length - 1;
  gates.forEach((x, i) => (x.reached = i <= end && x.status !== "not_run"));
  return { gates, stopAt };
}

function capsGates(r: LaneResult | undefined): { gates: Gate[]; stopAt: number | null } {
  if (!r) return { gates: [{ status: "bypassed", codes: [], reached: false }], stopAt: null };
  const fail = r.verdict === "BLOCK";
  return { gates: [{ status: fail ? "fail" : "pass", codes: r.codes, reached: true }], stopAt: fail ? 0 : null };
}

function laneStory(o: Outcome, l: LaneId): LaneStory {
  const v = o.lanes[l].verdict;
  const results = attacks(o, l);
  const r = decisive(results);
  const { gates, stopAt } = l === "sealed" ? sealedGates(r) : l === "caps-only" ? capsGates(r) : { gates: [], stopAt: null };
  const held = results.some((x) => x.verdict === "WARN");
  const owner = held ? (results.some((x) => x.verdict === "WARN" && x.executed) ? "approved" : "rejected") : undefined;
  const outcome: LaneOutcome =
    v.stolenCents > 0 ? "lost" : v.foreignKeys.length ? "key" : results.length === 0 ? "untouched" : results.some((x) => x.verdict === "BLOCK") ? "stopped" : owner === "rejected" ? "owner-rejected" : owner === "approved" ? "owner-approved" : "delivered";
  return { outcome, lostCents: v.stolenCents, keysAdded: v.foreignKeys.length, requests: results.length, gates, stopAt, owner, codes: [...new Set(results.flatMap((x) => x.codes))] };
}

const HIGHLIGHT = [/(?:[.\-]{1,6}[ /]+){4,}[.\-]{1,6}/g, /ignore (?:all |your )?(?:previous |prior )?(?:instructions|rules)/gi, /do not tell anyone/gi, /urgent[^.:]*/gi, /forget your rules/gi];
export function highlights(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const re of HIGHLIGHT) for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out.sort((a, b) => a[0] - b[0]).filter((h, i, all) => i === 0 || h[0] >= all[i - 1]![1]);
}

/** What happens in an attack that goes around every agent, in plain words. */
const AROUND: Record<string, string> = {
  "B-GATE-HOST": "The server running SeIn is taken over, and it sends the money itself.",
  "B-FORGED-VERDICT": "A forged approval goes straight to the signer, and the signer trusts it.",
  "N-STOLEN-KEY": "Someone signs with a stolen key, without asking any agent.",
  "N-SILENT-REFUND": "A bug inside the token contract moves the money, with no signature at all.",
};

const distance = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
};

function centsOf(action: ArenaEvent["action"], run: Run): number {
  if (!action?.amount || !action.token) return 0;
  const p = run.manifest.prices[action.token];
  return p ? Math.round((Number(action.amount) / 10 ** p.decimals) * p.priceUsd * 100) : 0;
}

function askOf(e: ArenaEvent | undefined, run: Run): StoryCase["ask"] {
  const a = e?.action;
  const what = (e?.summary ?? "").replace(/^agent decides to /, "").replace(/: (ALLOW|WARN|BLOCK).*$/, "");
  if (a?.kind === "add_key") return { what, label: "key", form: "key", cents: 0 };
  if (a?.kind === "sign_message") return { what, label: "signature", form: "signature", cents: 0 };
  const cents = centsOf(a, run);
  return { what, label: usd(cents).replace(/\.00$/, ""), form: "money", cents };
}

function momentOf(o: Outcome, run: Run, recipient: string | undefined, legit: string[]): Moment {
  const id = o.scenario.id;
  const notes = o.events.filter((e) => e.lane === "attacker" && e.type !== "inbox").map((e) => e.summary);
  if (o.scenario.expectedSealed === "ESCAPES" && attacks(o, "sealed").length === 0) return { kind: "bypass", how: o.events.find((e) => e.lane === "chain")?.summary ?? "it went around every check" };
  if (o.scenario.group === "fooled") return { kind: "message" };
  if (id === "S-LOOKALIKE" && recipient) {
    const real = legit.find((r) => r !== recipient && distance(r, recipient) <= 2);
    if (real) return { kind: "address-diff", real, fake: recipient };
  }
  if (id === "S-WHOLE-BALANCE") {
    const e = o.events.find((x) => x.lane === "no-guard" && x.result?.phase === "attack");
    const token = e?.action?.token;
    const have = token ? Number(o.before["no-guard"][run.manifest.victim]?.balances[token] ?? 0) : 0;
    if (have > 0) return { kind: "budget-gauge", sharePct: Math.round((Number(e!.action!.amount) / have) * 100) };
  }
  if (id === "S-BAD-QUOTE") {
    const m = notes.join(" ").match(/(\d+)% of value/);
    if (m) return { kind: "price-gap", lossPct: Number(m[1]) };
  }
  if (id === "S-SECOND-ACTION" || id === "S-OWNERSHIP") return { kind: "key-xray" };
  if (id === "S-SIGN") return { kind: "signature" };
  if (attacks(o, "sealed").length > 3) return { kind: "burst", count: attacks(o, "sealed").length };
  return { kind: "none" };
}

function attackCase(o: Outcome, run: Run, legit: string[]): StoryCase {
  const inbox = o.events.find((e) => e.lane === "attacker" && e.type === "inbox" && !e.summary.startsWith("[L-"));
  const parsed = inbox?.summary.match(/^from (.+?): (.*)$/s);
  const first = o.events.find((e) => e.lane === "no-guard" && e.result?.phase === "attack");
  const lanes = Object.fromEntries(LANES.map((l) => [l, laneStory(o, l)])) as Record<LaneId, LaneStory>;
  const thief = Object.keys(o.lanes["no-guard"].verdict.stolenByAttacker ?? {})[0];
  const recipient = first?.action?.recipient;
  const attackers = new Set([...(o.scenario.attackers ?? []), ...String(run.manifest.accounts?.attackers ?? "").split(",")]);
  const sealed = decisive(attacks(o, "sealed"));
  const chainNote = o.events.find((e) => e.lane === "chain")?.summary;
  return {
    id: o.scenario.id,
    title: o.scenario.title,
    kind: "attack",
    group: o.scenario.group,
    outOfScope: o.scenario.expectedSealed === "ESCAPES",
    pattern: o.scenario.pattern,
    summary: o.scenario.summary,
    message: parsed ? { from: parsed[1]!, text: parsed[2]!, highlights: highlights(parsed[2]!) } : chainNote ? { from: "What happens", text: AROUND[o.scenario.id] ?? "The money leaves without any agent asking.", highlights: [] } : undefined,
    ask: first ? askOf(first, run) : { what: "", label: usd(o.lanes["no-guard"].verdict.stolenCents).replace(/\.00$/, ""), form: "money", cents: o.lanes["no-guard"].verdict.stolenCents },
    destination: thief ? { name: thief, attacker: true } : { name: recipient ?? "", attacker: !!recipient && attackers.has(recipient) },
    lanes,
    moment: momentOf(o, run, recipient, legit),
    receipt: sealed?.decisionId ? { decisionId: sealed.decisionId, verdict: sealed.verdict, codes: sealed.codes, warnCodes: sealed.warnCodes ?? [] } : undefined,
  };
}

/** An ordinary task from the same recording: proof that honest payments go through every lane. */
function everydayCase(o: Outcome, run: Run): StoryCase | undefined {
  const inbox = o.events.find((e) => e.lane === "attacker" && e.type === "inbox" && e.summary.startsWith("[L-"));
  if (!inbox) return undefined;
  const after = (l: LaneId) => o.events.find((e) => e.lane === l && e.type === "decision" && e.seq > inbox.seq && e.result?.phase === "task");
  const results = Object.fromEntries(LANES.map((l) => [l, after(l)])) as Record<LaneId, ArenaEvent | undefined>;
  if (LANES.some((l) => !results[l]?.result?.executed)) return undefined;
  const lane = (l: LaneId): LaneStory => {
    const r = results[l]!.result!;
    const gates = l === "sealed" ? sealedGates(r).gates : l === "caps-only" ? capsGates(r).gates : [];
    return { outcome: "delivered", lostCents: 0, keysAdded: 0, requests: 1, gates, stopAt: null, codes: r.codes };
  };
  const a = results["no-guard"]!.action;
  const text = inbox.summary.replace(/^\[L-[A-Z]+\] /, "");
  return {
    id: "EVERYDAY",
    title: "An everyday payment",
    kind: "everyday",
    group: "everyday",
    outOfScope: false,
    summary: "A routine payment to a known receiver. It must go through every lane, or the guard is useless.",
    message: { from: "finance", text, highlights: [] },
    ask: { what: `pay ${usd(centsOf(a, run)).replace(/^\$/, "")} USDC to ${a?.recipient}`, label: usd(centsOf(a, run)).replace(/\.00$/, ""), form: "money", cents: centsOf(a, run) },
    destination: { name: a?.recipient ?? "", attacker: false },
    lanes: Object.fromEntries(LANES.map((l) => [l, lane(l)])) as Record<LaneId, LaneStory>,
    moment: { kind: "none" },
  };
}

export const FEATURED = ["EVERYDAY", "S-MORSE", "S-LOOKALIKE", "S-SECOND-ACTION", "B-GATE-HOST"];

export function buildStoryboard(run: Run, dir: string): Storyboard {
  const legit = [...new Set(run.outcomes.flatMap((o) => o.events.filter((e) => e.result?.phase === "task" && e.action?.recipient).map((e) => e.action!.recipient!)))];
  const everyday = everydayCase(run.outcomes[0]!, run);
  const cases = [...(everyday ? [everyday] : []), ...run.outcomes.map((o) => attackCase(o, run, legit))];
  const totals = Object.fromEntries(
    LANES.map((l) => {
      const inScope = run.outcomes.filter((o) => o.scenario.expectedSealed !== "ESCAPES");
      const out = run.outcomes.filter((o) => o.scenario.expectedSealed === "ESCAPES");
      const hit = (o: Outcome) => o.lanes[l].verdict.stolenCents > 0 || o.lanes[l].verdict.foreignKeys.length > 0;
      const t = run.totals[l];
      return [l, { lostIn: inScope.reduce((n, o) => n + o.lanes[l].verdict.stolenCents, 0), lostOut: out.reduce((n, o) => n + o.lanes[l].verdict.stolenCents, 0), stoppedIn: inScope.filter((o) => !hit(o)).length, inScope: inScope.length, outOfScope: out.length, legitDone: t.legitDone, legitTotal: t.legitTotal, falseBlocks: t.falseBlocks.length }];
    }),
  ) as Storyboard["totals"];
  return { runId: run.manifest.runId, dir, approver: run.manifest.approver, chain: run.manifest.chain, createdAt: run.manifest.createdAt, featured: FEATURED.filter((id) => cases.some((c) => c.id === id)), cases, totals };
}

/** How the stage draws a gate. Only a check that ran, passed and was reached may look passed. */
export function gateLook(g: Gate): "passed" | "flagged" | "stopped" | "dark" | "dashed" {
  if (g.status === "bypassed") return "dashed";
  if (!g.reached || g.status === "not_run") return "dark";
  return g.status === "fail" ? "stopped" : g.status === "warn" ? "flagged" : "passed";
}
