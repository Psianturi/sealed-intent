#!/usr/bin/env tsx
/**
 *   pnpm arena:run [--approver lazy] [--all]     run the catalog on the simulated ledger, record to replays/
 *   pnpm arena:replay [runId]                     print a recorded run (default: newest)
 *   pnpm arena:verify [runId]                     re-sign-check the manifest and recompute the referee
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS } from "./catalog";
import { loadRun, record, verifyRun } from "./recorder";
import { runArena, type RunResult } from "./runner";

const [cmd = "run", ...rest] = process.argv.slice(2);
const flag = (f: string) => rest.includes(f);
const value = (f: string) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
const root = "replays";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

function newest(): string | undefined {
  try {
    return readdirSync(root)
      .filter((d) => statSync(join(root, d)).isDirectory())
      .sort((a, b) => statSync(join(root, b)).mtimeMs - statSync(join(root, a)).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

function scoreboard(r: Pick<RunResult, "manifest" | "outcomes" | "totals">): string {
  const lanes = ["no-guard", "caps-only", "sealed"] as const;
  const names = { "no-guard": "No guard", "caps-only": "Caps only", sealed: "Sealed Intent" };
  const w = 16;
  const row = (label: string, f: (l: (typeof lanes)[number]) => string) => label.padEnd(22) + lanes.map((l) => f(l).padStart(w)).join("");
  const n = r.outcomes.length;
  const lines = [
    `Sealed Intent Arena  run=${r.manifest.runId}  chain=${String(r.manifest.chain).toUpperCase()} (simulated)  victim=${r.manifest.victim}  approver=${r.manifest.approver}`,
    `${n} scenarios x 6 legit tasks each. Referee reads balances only. Test tokens at fixed reference prices.`,
    "",
    "".padEnd(22) + lanes.map((l) => names[l].padStart(w)).join(""),
    row("Stolen (test USD)", (l) => usd(r.totals[l].stolenCents)),
    row("Attacks escaped", (l) => `${r.totals[l].escaped.length}/${n}`),
    row("Legit done", (l) => `${r.totals[l].legitDone}/${r.totals[l].legitTotal}`),
    row("False blocks", (l) => String(r.totals[l].falseBlocks.length)),
    row("Foreign keys left", (l) => String(r.totals[l].foreignKeys)),
    "",
    "Scenario".padEnd(22) + "Pattern".padEnd(30) + lanes.map((l) => names[l].padStart(w)).join("") + "   expected",
  ];
  for (const o of r.outcomes) {
    const cell = (l: (typeof lanes)[number]) => {
      const v = o.lanes[l].verdict;
      if (v.stolenCents > 0) return `LOST ${usd(v.stolenCents)}`;
      if (v.foreignKeys.length) return "KEY ADDED";
      const attack = o.lanes[l].results.filter((r) => r.phase === "attack");
      if (attack.some((r) => r.verdict === "BLOCK")) return "BLOCK";
      if (attack.some((r) => r.verdict === "WARN" && !r.executed)) return "WARN, rejected";
      if (attack.some((r) => r.verdict === "WARN")) return "WARN, approved";
      return attack.some((r) => !r.executed) ? "failed on chain" : "safe";
    };
    lines.push(o.scenario.id.padEnd(22) + (o.scenario.pattern?.incident ?? o.scenario.origin).slice(0, 29).padEnd(30) + lanes.map((l) => cell(l).padStart(w)).join("") + `   ${o.scenario.expectedSealed}`);
  }
  const escaped = r.outcomes.filter((o) => o.lanes.sealed.verdict.stolenCents > 0 || o.lanes.sealed.verdict.foreignKeys.length);
  lines.push("", `Escaped through Sealed Intent (${escaped.length}):`);
  for (const o of escaped) lines.push(`  ${o.scenario.id}: ${o.scenario.summary}`);
  if (!escaped.length) lines.push("  none");
  lines.push("", "Real vs simulated:");
  for (const [k, v] of Object.entries(r.manifest.realVsSimulated as Record<string, string>)) lines.push(`  ${k.padEnd(8)} ${v}`);
  return lines.join("\n");
}

if (cmd === "run") {
  const result = await runArena({ approver: flag("--approver") && value("--approver") === "lazy" ? "lazy" : "strict", scenarios: flag("--all") ? SCENARIOS : undefined });
  const dir = record(result, root);
  console.log(scoreboard(result));
  console.log(`\nRecorded to ${dir}. Verify: pnpm arena:verify ${result.manifest.runId}`);
} else if (cmd === "replay") {
  const id = rest[0] ?? newest();
  const run = id && loadRun(join(root, id));
  if (!run) {
    console.log("No recorded run yet. Run `pnpm arena:run` to create one.");
    process.exit(2);
  }
  console.log(scoreboard(run as never));
} else if (cmd === "verify") {
  const id = rest[0] ?? newest();
  if (!id) {
    console.log("No recorded run yet.");
    process.exit(2);
  }
  const v = verifyRun(join(root, id));
  console.log(`${id}: manifest signature ${v.manifestSignatureValid ? "VALID" : "INVALID"}, referee recomputed from balances ${v.refereeRecomputedMatches ? "MATCHES" : "DIFFERS"}`);
  for (const p of v.problems) console.log(`  ! ${p}`);
  process.exit(v.manifestSignatureValid && v.refereeRecomputedMatches ? 0 : 1);
} else {
  console.log("usage: arena run|replay|verify");
  process.exit(2);
}
