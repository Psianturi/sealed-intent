// Types and pure rendering for recorded Arena runs. Used by the browser and, at build time, by vite.config.ts.
export type LaneId = "no-guard" | "caps-only" | "sealed";
export const LANES: LaneId[] = ["no-guard", "caps-only", "sealed"];
export const LANE_NAMES: Record<LaneId, string> = { "no-guard": "No guard", "caps-only": "Limits only", sealed: "SeIn" };
/** The five checks. The same names on the landing page and in the Arena. */
export const GATES = ["Deal real?", "Who gets it?", "A payment?", "Tricked?", "In budget?"];

export interface LaneResult {
  lane: LaneId;
  phase?: "task" | "attack";
  verdict: "ALLOW" | "WARN" | "BLOCK";
  codes: string[];
  warnCodes?: string[];
  executed: boolean;
  error?: string;
  decisionId?: string;
}
export interface Verdict {
  stolenCents: number;
  stolenByAttacker?: Record<string, number>;
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
  manifest: { runId: string; createdAt: string; chain: string; victim: string; approver: string; policyHash: string; catalogHash: string; realVsSimulated: Record<string, string>; prices: Record<string, { decimals: number; priceUsd: number }>; accounts?: Record<string, string>; issuer?: string; signature?: string };
  outcomes: Outcome[];
  totals: Record<LaneId, { stolenCents: number; escaped: string[]; compromised?: string[]; legitDone: number; legitTotal: number; falseBlocks: string[]; foreignKeys: number }>;
}

export async function loadRun(base: string): Promise<Run> {
  const get = async <T>(f: string) => (await fetch(`${base}/${f}`, { cache: "no-store" })).json() as Promise<T>;
  const [manifest, outcomes, totals] = await Promise.all([get<Run["manifest"]>("manifest.json"), get<Outcome[]>("outcomes.json"), get<Run["totals"]>("referee.json")]);
  return { manifest, outcomes, totals };
}

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const hit = (o: Outcome, l: LaneId) => o.lanes[l].verdict.stolenCents > 0 || o.lanes[l].verdict.foreignKeys.length > 0;
const outOfScope = (o: Outcome) => o.scenario.expectedSealed === "ESCAPES";

/** Attacks a checker can stop versus those it cannot by design. Recomputed from the recording, never typed in. */
export function scopeOf(run: Run) {
  const inScope = run.outcomes.filter((o) => !outOfScope(o));
  const out = run.outcomes.filter(outOfScope);
  const lane = (l: LaneId) => {
    const sum = (list: Outcome[]) => list.reduce((n, o) => n + o.lanes[l].verdict.stolenCents, 0);
    return { stoppedIn: inScope.filter((o) => !hit(o, l)).length, stoppedOut: out.filter((o) => !hit(o, l)).length, lostIn: sum(inScope), lostOut: sum(out) };
  };
  const stopped = inScope.filter((o) => !hit(o, "sealed"));
  const auto = stopped.filter((o) => o.lanes.sealed.results.some((r) => r.phase === "attack" && r.verdict === "BLOCK")).length;
  return { inScope: inScope.length, outOfScope: out.length, lanes: { "no-guard": lane("no-guard"), "caps-only": lane("caps-only"), sealed: lane("sealed") }, auto, byOwner: stopped.length - auto };
}

function pips(run: Run, l: LaneId): string {
  const pip = (o: Outcome) => {
    const through = hit(o, l);
    return `<span class="pip ${through ? "through" : "held"}${outOfScope(o) ? " oos" : ""}" title="${esc(o.scenario.title)}: ${through ? "got through" : "stopped"}">${through ? "✕" : "✓"}</span>`;
  };
  return `<div class="pips">${run.outcomes.filter((o) => !outOfScope(o)).map(pip).join("")}<span class="pip-gap"></span>${run.outcomes.filter(outOfScope).map(pip).join("")}</div>`;
}

export function renderScore(run: Run): string {
  const s = scopeOf(run);
  return LANES.map((l) => {
    const t = run.totals[l];
    const c = s.lanes[l];
    return `<article class="lane ${l}"><h3>${LANE_NAMES[l]}</h3>
      <p class="big">${usd(c.lostIn)}<small>lost to attacks in scope</small></p>
      ${pips(run, l)}
      <dl>
        <div><dt>In scope, stopped</dt><dd>${c.stoppedIn} of ${s.inScope}</dd></div>
        <div><dt>Out of scope, stopped</dt><dd>${c.stoppedOut} of ${s.outOfScope}</dd></div>
        <div><dt>Lost out of scope</dt><dd>${usd(c.lostOut)}</dd></div>
        <div><dt>Everyday tasks finished</dt><dd>${t.legitDone} of ${t.legitTotal}</dd></div>
        <div><dt>Honest payments blocked</dt><dd>${t.falseBlocks.length}</dd></div>
        <div><dt>Attacker keys left behind</dt><dd>${t.foreignKeys}</dd></div>
      </dl></article>`;
  }).join("");
}

export const PIP_LEGEND = `<p class="legend-line"><span class="pip held">✓</span> stopped <span class="pip through">✕</span> got through. The left group is in scope. The right group is out of scope by design: a stolen custody key, a forged verdict, a compromised checker, a lying data source, a bug inside a token.</p>`;

export function scopeSentence(run: Run): string {
  const s = scopeOf(run);
  const c = s.lanes.sealed;
  const how = run.manifest.approver === "lazy" ? "Here the owner approves everything without reading." : `${s.auto} blocked automatically, ${s.byOwner} stopped because the owner rejected a WARN.`;
  return `In scope, SeIn stopped ${c.stoppedIn} of ${s.inScope}. ${how} Out of scope by design: ${s.outOfScope}, shown on purpose. Test tokens only.`;
}

export function cell(o: Outcome, l: LaneId): { text: string; cls: string } {
  const v = o.lanes[l].verdict;
  if (v.stolenCents > 0) return { text: `Lost ${usd(v.stolenCents)}`, cls: "lost" };
  if (v.foreignKeys.length) return { text: "Key added", cls: "key" };
  const attack = o.lanes[l].results.filter((r) => r.phase === "attack");
  if (attack.some((r) => r.verdict === "BLOCK")) return { text: "Blocked", cls: "block" };
  if (attack.some((r) => r.verdict === "WARN" && !r.executed)) return { text: "Owner rejected", cls: "warn" };
  if (attack.some((r) => r.verdict === "WARN")) return { text: "Owner approved", cls: "warn" };
  return attack.some((r) => !r.executed) ? { text: "Failed on chain", cls: "sim" } : { text: "Safe", cls: "allow" };
}

const EXPECTED: Record<string, string> = { ALLOW: "Allowed", WARN: "Owner decides", BLOCK: "Blocked", ESCAPES: "Gets through" };

export function renderRows(run: Run): string {
  return run.outcomes
    .map((o) => {
      const cells = LANES.map((l) => {
        const c = cell(o, l);
        return `<td data-label="${LANE_NAMES[l]}"><span class="chip ${c.cls}">${esc(c.text)}</span></td>`;
      }).join("");
      const pat = o.scenario.pattern ? `<span><a href="${esc(o.scenario.pattern.source)}">${esc(o.scenario.pattern.incident)}</a>, ${esc(o.scenario.pattern.date)}</span>` : `<span class="note">Hypothetical</span>`;
      return `<tr class="clickable" data-id="${esc(o.scenario.id)}"><td data-label="Attack"><strong>${esc(o.scenario.title)}</strong><br><span class="note">${esc(o.scenario.summary)}</span></td><td data-label="Pattern from">${pat}</td>${cells}<td data-label="We predicted"><span class="chip sim">${esc(EXPECTED[o.scenario.expectedSealed] ?? o.scenario.expectedSealed)}</span></td></tr>`;
    })
    .join("");
}

export function renderEscaped(run: Run): string {
  const list = run.outcomes.filter((o) => hit(o, "sealed"));
  return list.length ? list.map((o) => `<li><strong>${esc(o.scenario.title)}</strong> (${usd(o.lanes.sealed.verdict.stolenCents)}): ${esc(o.scenario.summary)}</li>`).join("") : "<li>No attack moved funds to an attacker in this run.</li>";
}

const HONEST: Record<string, string> = { chain: "The chain", quotes: "Quotes", tee: "Enclave opinion", custody: "Custody", victim: "The agent", rules: "The rules" };

export function renderHonesty(run: Run): string {
  return Object.entries(run.manifest.realVsSimulated)
    .map(([k, v]) => {
      const m = v.match(/^([^()]+?)\s*\((.*)\)$/);
      const head = (m?.[1] ?? v).trim();
      const real = /^REAL/i.test(head);
      return `<tr><th scope="row">${esc(HONEST[k] ?? k)}</th><td><span class="status ${real ? "live" : "sim"}">${real ? "Real" : "Simulated"}</span></td><td>${esc(m?.[2] ?? v)}</td></tr>`;
    })
    .join("");
}

export function renderMeta(run: Run): string {
  const m = run.manifest;
  return `Recorded ${esc(m.createdAt.slice(0, 10))} on ${m.chain === "sandbox" ? "three real local NEAR nodes, with the same result as the simulated chain" : "a simulated chain, and reproduced with the same result on three real local NEAR nodes"}. ${m.approver === "lazy" ? "The owner approves every WARN without reading." : "The owner reads each WARN before answering."} The rules and the attack list were locked before the run.`;
}

export function renderFingerprints(run: Run): string {
  const m = run.manifest;
  return `Run <code>${esc(m.runId)}</code>. Policy fingerprint <code>${esc(m.policyHash.slice(0, 16))}…</code>. Attack list fingerprint <code>${esc(m.catalogHash.slice(0, 16))}…</code>. The recording is signed, and the score can be recomputed from its balances. The steps are in the repository.`;
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
