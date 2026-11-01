export type LaneId = "no-guard" | "caps-only" | "sealed";
export const LANES: LaneId[] = ["no-guard", "caps-only", "sealed"];
export const LANE_NAMES: Record<LaneId, string> = { "no-guard": "No guard", "caps-only": "Caps only", sealed: "Sealed Intent" };

export interface LaneResult {
  lane: LaneId;
  phase?: "task" | "attack";
  verdict: "ALLOW" | "WARN" | "BLOCK";
  codes: string[];
  executed: boolean;
  error?: string;
  decisionId?: string;
}
export interface Verdict {
  stolenCents: number;
  legitDone: number;
  legitTotal: number;
  falseBlocks: string[];
  escaped: string[];
  foreignKeys: string[];
  codeChanged: boolean;
}
export interface ArenaEvent {
  seq: number;
  scenario: string;
  lane: LaneId | "chain" | "attacker" | "human";
  type: string;
  summary: string;
  action?: Record<string, string | undefined> & { kind: string };
  result?: LaneResult;
}
export interface Outcome {
  scenario: { id: string; title: string; group: string; origin: string; pattern?: { incident: string; date: string; source: string }; summary: string; expectedSealed: string; cannotReplicate?: string; attackers?: string[] };
  lanes: Record<LaneId, { verdict: Verdict; results: LaneResult[] }>;
  events: ArenaEvent[];
  before: Record<LaneId, Snapshot>;
  after: Record<LaneId, Snapshot>;
}
export type Snapshot = Record<string, { balances: Record<string, string>; keys: { publicKey: string }[]; codeHash: string | null }>;
export interface Run {
  manifest: { runId: string; createdAt: string; chain: string; victim: string; approver: string; policyHash: string; catalogHash: string; realVsSimulated: Record<string, string>; prices: Record<string, { decimals: number; priceUsd: number }>; issuer?: string; signature?: string };
  outcomes: Outcome[];
  totals: Record<LaneId, { stolenCents: number; escaped: string[]; legitDone: number; legitTotal: number; falseBlocks: string[]; foreignKeys: number }>;
}

export async function loadRun(base: string): Promise<Run> {
  const get = async <T>(f: string) => (await fetch(`${base}/${f}`, { cache: "no-store" })).json() as Promise<T>;
  const [manifest, outcomes, totals] = await Promise.all([get<Run["manifest"]>("manifest.json"), get<Outcome[]>("outcomes.json"), get<Run["totals"]>("referee.json")]);
  return { manifest, outcomes, totals };
}

export const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export function renderScore(run: Run): string {
  const n = run.outcomes.length;
  return LANES.map((l) => {
    const t = run.totals[l];
    return `<div class="lane ${l}"><h4>${LANE_NAMES[l]}</h4>
      <div class="row"><span>Stolen (test USD)</span><span class="v ${t.stolenCents ? "bad" : ""}">${usd(t.stolenCents)}</span></div>
      <div class="row"><span>Attacks escaped</span><span class="v">${t.escaped.length}/${n}</span></div>
      <div class="row"><span>Legit tasks done</span><span class="v">${t.legitDone}/${t.legitTotal}</span></div>
      <div class="row"><span>False blocks</span><span class="v">${t.falseBlocks.length}</span></div>
      <div class="row"><span>Foreign keys left</span><span class="v">${t.foreignKeys}</span></div></div>`;
  }).join("");
}

export function cell(o: Outcome, l: LaneId): { text: string; cls: string } {
  const v = o.lanes[l].verdict;
  if (v.stolenCents > 0) return { text: `LOST ${usd(v.stolenCents)}`, cls: "lost" };
  if (v.foreignKeys.length) return { text: "KEY ADDED", cls: "key" };
  const attack = o.lanes[l].results.filter((r) => r.phase === "attack");
  if (attack.some((r) => r.verdict === "BLOCK")) return { text: "BLOCK", cls: "block" };
  if (attack.some((r) => r.verdict === "WARN" && !r.executed)) return { text: "WARN, rejected", cls: "warn" };
  if (attack.some((r) => r.verdict === "WARN")) return { text: "WARN, approved", cls: "warn" };
  return attack.some((r) => !r.executed) ? { text: "failed on chain", cls: "sim" } : { text: "safe", cls: "allow" };
}

export function delta(o: Outcome, l: LaneId, prices: Run["manifest"]["prices"]): { account: string; token: string; change: number }[] {
  const out: { account: string; token: string; change: number }[] = [];
  for (const [acc, a] of Object.entries(o.after[l])) {
    for (const [token, v] of Object.entries(a.balances)) {
      const b = BigInt(o.before[l][acc]?.balances[token] ?? "0");
      const d = BigInt(v) - b;
      if (d === 0n) continue;
      const p = prices[token];
      out.push({ account: acc, token, change: p ? (Number(d) / 10 ** p.decimals) * p.priceUsd : 0 });
    }
  }
  return out.sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
}
