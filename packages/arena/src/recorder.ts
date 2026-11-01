import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, loadOrCreateIssuerKey, signBytes, verifyBytes } from "@sealed-intent/receipt";
import type { LaneId } from "./lanes";
import { referee, type RefereeTask } from "./referee";
import type { RunResult } from "./runner";
import { ACC, ATTACKERS, TOKENS } from "./world";

/**
 * replays/<runId>/
 *   manifest.json   signed: run settings, hashes, real-vs-simulated labels
 *   events.jsonl    one event per line
 *   outcomes.json   per scenario: snapshots before/after per lane, lane results, referee verdicts
 *   referee.json    totals
 */
export function record(result: RunResult, root = "replays", issuerPath = ".sealed/issuer.pem"): string {
  const dir = join(root, result.manifest.runId);
  mkdirSync(dir, { recursive: true });
  const issuer = loadOrCreateIssuerKey(issuerPath);
  const manifest = { ...result.manifest, issuer: issuer.publicKeyHex };
  const signed = { ...manifest, signature: signBytes(issuer, canonicalJson(manifest)) };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(signed, null, 2));
  writeFileSync(join(dir, "events.jsonl"), result.outcomes.flatMap((o) => o.events).map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(dir, "outcomes.json"), JSON.stringify(result.outcomes, null, 1));
  writeFileSync(join(dir, "referee.json"), JSON.stringify(result.totals, null, 2));
  return dir;
}

export interface VerifyReport {
  manifestSignatureValid: boolean;
  refereeRecomputedMatches: boolean;
  problems: string[];
}

/** Recomputes every verdict from the recorded snapshots and compares with referee.json. */
export function verifyRun(dir: string): VerifyReport {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown> & { signature: string; issuer: string };
  const { signature, ...unsigned } = manifest;
  const manifestSignatureValid = verifyBytes(manifest.issuer, canonicalJson(unsigned), signature);
  if (!manifestSignatureValid) problems.push("manifest signature invalid");
  const outcomes = JSON.parse(readFileSync(join(dir, "outcomes.json"), "utf8")) as RunResult["outcomes"];
  const recorded = JSON.parse(readFileSync(join(dir, "referee.json"), "utf8")) as RunResult["totals"];
  const totals: Record<string, { stolenCents: number; legitDone: number }> = {};
  for (const id of ["no-guard", "caps-only", "sealed"] as LaneId[]) {
    let stolen = 0;
    let done = 0;
    for (const o of outcomes) {
      const refTasks = refereeTasksFrom(o);
      const v = referee({ before: o.before[id], after: o.after[id], tasks: refTasks, attackerAccounts: [...new Set([...ATTACKERS, ...(o.scenario.attackers ?? [])])], agentAccount: ACC.agent, prices: manifest.prices as typeof TOKENS, attacks: [], spendCapCents: undefined });
      stolen += v.stolenCents;
      done += v.legitDone;
      if (v.stolenCents !== o.lanes[id].verdict.stolenCents) problems.push(`${o.scenario.id}/${id}: stolen ${v.stolenCents} recomputed vs ${o.lanes[id].verdict.stolenCents} recorded`);
    }
    totals[id] = { stolenCents: stolen, legitDone: done };
    if (stolen !== recorded[id].stolenCents) problems.push(`${id}: total stolen ${stolen} recomputed vs ${recorded[id].stolenCents} recorded`);
    if (done !== recorded[id].legitDone) problems.push(`${id}: legit done ${done} recomputed vs ${recorded[id].legitDone} recorded`);
  }
  return { manifestSignatureValid, refereeRecomputedMatches: problems.length === 0, problems };
}

/** The task list is reconstructed from the inbox events, so verification needs no separate copy. */
function refereeTasksFrom(o: RunResult["outcomes"][number]): RefereeTask[] {
  const out: RefereeTask[] = [];
  for (const e of o.events) {
    if (e.type !== "inbox" || !e.summary.startsWith("[L-")) continue;
    const id = e.summary.slice(1, e.summary.indexOf("]"));
    const decision = o.events.find((d) => d.type === "decision" && d.seq > e.seq && d.lane === "sealed");
    const a = decision?.action;
    if (!a) continue;
    out.push({ id, token: a.kind === "swap" ? a.tokenOut! : a.token!, recipient: a.recipient ?? ACC.agent, amount: a.kind === "swap" ? "0" : a.amount!, toleranceBps: 0 });
  }
  return out;
}

export function loadRun(dir: string): { manifest: Record<string, unknown>; outcomes: RunResult["outcomes"]; totals: RunResult["totals"] } | undefined {
  if (!existsSync(join(dir, "manifest.json"))) return undefined;
  return {
    manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
    outcomes: JSON.parse(readFileSync(join(dir, "outcomes.json"), "utf8")),
    totals: JSON.parse(readFileSync(join(dir, "referee.json"), "utf8")),
  };
}
