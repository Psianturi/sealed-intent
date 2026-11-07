// The deck for "Be the guard": every card is a request from the official recording, with what SeIn really
// decided and what the other two wallets lost. Pure: used at build time and by the tests.
import type { LaneId, Run } from "./arena-data";
import type { Storyboard } from "./storyboard";

export interface Card {
  id: string;
  kind: "attack" | "task";
  outOfScope: boolean;
  title: string;
  from: string;
  message: string;
  /** what the agent wants to do, in one line */
  ask: string;
  receiver: string;
  cents: number;
  sein: { verdict: "ALLOW" | "WARN" | "BLOCK" | "NONE"; codes: string[]; warnCodes: string[]; outcome: string; lostCents: number };
  lost: Record<Exclude<LaneId, "sealed">, number>;
  /** attacker keys left on each wallet */
  keys: Record<LaneId, number>;
  pattern?: { incident: string; date: string };
  why?: string;
}

const TOKENS: [RegExp, number, string][] = [[/17208628|usdc/i, 6, "USDC"], [/wrap\./, 24, "wNEAR"], [/usdt/, 6, "USDT"]];
const units = (amount: string, token: string) => {
  const t = TOKENS.find(([re]) => re.test(token));
  return t ? { n: Number(amount) / 10 ** t[1], sym: t[2] } : { n: Number(amount), sym: "" };
};

export function buildDeck(run: Run, board: Storyboard): Card[] {
  const cards: Card[] = [];
  for (const c of board.cases.filter((x) => x.kind === "attack")) {
    const s = c.lanes.sealed;
    cards.push({
      id: c.id,
      kind: "attack",
      outOfScope: c.outOfScope,
      title: c.title,
      from: c.message?.from ?? "unknown",
      message: c.message?.text ?? c.summary,
      ask: c.ask.what || "",
      receiver: c.destination.name,
      cents: c.ask.cents,
      sein: { verdict: (c.receipt?.verdict as Card["sein"]["verdict"]) ?? "NONE", codes: c.receipt?.codes ?? [], warnCodes: c.receipt?.warnCodes ?? [], outcome: s.outcome, lostCents: s.lostCents },
      lost: { "no-guard": c.lanes["no-guard"].lostCents, "caps-only": c.lanes["caps-only"].lostCents },
      keys: { "no-guard": c.lanes["no-guard"].keysAdded, "caps-only": c.lanes["caps-only"].keysAdded, sealed: s.keysAdded },
      pattern: c.pattern ? { incident: c.pattern.incident, date: c.pattern.date } : undefined,
      why: c.summary,
    });
  }
  // honest tasks: the first decision of each kind, with the message that asked for it
  const seen = new Set<string>();
  for (const o of run.outcomes) {
    const inbox = o.events.filter((e) => e.lane === "attacker" && e.type === "inbox");
    for (const e of o.events) {
      if (e.lane !== "sealed" || e.type !== "decision" || e.result?.phase !== "task" || !e.action) continue;
      const title = e.summary.split(":")[0]!.trim();
      if (seen.has(title) || e.result.verdict === "BLOCK") continue;
      seen.add(title);
      const msg = [...inbox].reverse().find((m) => m.seq < e.seq);
      const a = e.action;
      const u = units(a.amount ?? "0", a.token ?? "");
      const ask = a.kind === "swap" ? `swap ${u.n.toFixed(2)} ${u.sym} to ${units("0", a.tokenOut ?? "").sym || "another token"}` : `pay ${u.n.toFixed(2)} ${u.sym} to ${a.recipient}`;
      cards.push({
        id: `task-${seen.size}`,
        kind: "task",
        outOfScope: false,
        title,
        from: msg?.summary.match(/^\[(L-[A-Z]+)\]/)?.[1]?.replace("L-", "").toLowerCase() ?? "finance",
        message: msg?.summary.replace(/^\[L-[A-Z]+\]\s*/, "") ?? title,
        ask,
        receiver: a.recipient ?? "",
        cents: u.sym.startsWith("USD") ? Math.round(u.n * 100) : 0,
        sein: { verdict: e.result.verdict, codes: e.result.codes, warnCodes: e.result.warnCodes ?? [], outcome: e.result.executed ? (e.result.verdict === "WARN" ? "owner-approved" : "paid") : "stopped", lostCents: 0 },
        lost: { "no-guard": 0, "caps-only": 0 },
        keys: { "no-guard": 0, "caps-only": 0, sealed: 0 },
      });
    }
  }
  return cards;
}

/** Ten rounds: six attacks SeIn is meant to stop, one it cannot, three honest tasks; a fresh mix each game. */
export function pickRounds(deck: Card[], random = Math.random): Card[] {
  const shuffle = <T>(a: T[]) => a.map((x) => [random(), x] as const).sort((p, q) => p[0] - q[0]).map(([, x]) => x);
  const inScope = shuffle(deck.filter((c) => c.kind === "attack" && !c.outOfScope)).slice(0, 6);
  const outScope = shuffle(deck.filter((c) => c.kind === "attack" && c.outOfScope)).slice(0, 1);
  const tasks = shuffle(deck.filter((c) => c.kind === "task")).slice(0, 3);
  return shuffle([...inScope, ...outScope, ...tasks]);
}

export type Choice = "allow" | "owner" | "block";

/** Points for one call. An attack that gets through costs what it stole; blocking an honest payment costs too. */
export function score(card: Card, choice: Choice): { points: number; stolenCents: number; honestBlocked: boolean; verdict: "right" | "careful" | "wrong" | "beyond" } {
  if (card.kind === "attack" && card.outOfScope) return { points: 0, stolenCents: 0, honestBlocked: false, verdict: "beyond" };
  if (card.kind === "attack") {
    if (choice === "block") return { points: 100, stolenCents: 0, honestBlocked: false, verdict: "right" };
    if (choice === "owner") return { points: 60, stolenCents: 0, honestBlocked: false, verdict: "careful" };
    // what the unguarded wallet really lost in the recording, not what the request asked for
    return { points: 0, stolenCents: card.lost["no-guard"], honestBlocked: false, verdict: "wrong" };
  }
  if (choice === "allow") return { points: 100, stolenCents: 0, honestBlocked: false, verdict: "right" };
  if (choice === "owner") return { points: card.sein.verdict === "WARN" ? 100 : 50, stolenCents: 0, honestBlocked: false, verdict: card.sein.verdict === "WARN" ? "right" : "careful" };
  return { points: 0, stolenCents: 0, honestBlocked: true, verdict: "wrong" };
}
