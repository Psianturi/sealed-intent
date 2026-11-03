import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LANES, type Run } from "../src/arena-data";
import { buildStoryboard, gateLook, sealedGates, type Storyboard } from "../src/storyboard";

const root = join(__dirname, "..", "..", "..", "replays");
const load = (dir: string): Run => {
  const get = (f: string) => JSON.parse(readFileSync(join(root, dir, f), "utf8"));
  return { manifest: get("manifest.json"), outcomes: get("outcomes.json"), totals: get("referee.json") };
};
const runs = ["official", "official-lazy", "official-sandbox"].map((d) => [d, load(d), buildStoryboard(load(d), d)] as [string, Run, Storyboard]);

describe.each(runs)("storyboard of %s", (_dir, run, sb) => {
  it("has every recorded case, plus one everyday payment", () => {
    expect(sb.cases.filter((c) => c.kind === "attack").map((c) => c.id)).toEqual(run.outcomes.map((o) => o.scenario.id));
    expect(sb.cases[0]!.kind).toBe("everyday");
  });

  it("shows exactly what the referee counted, case by case", () => {
    for (const o of run.outcomes) {
      const c = sb.cases.find((x) => x.id === o.scenario.id)!;
      for (const l of LANES) {
        expect(c.lanes[l].lostCents).toBe(o.lanes[l].verdict.stolenCents);
        expect(c.lanes[l].keysAdded).toBe(o.lanes[l].verdict.foreignKeys.length);
        expect(c.lanes[l].outcome === "lost").toBe(o.lanes[l].verdict.stolenCents > 0);
      }
    }
  });

  it("adds up to the referee's totals", () => {
    for (const l of LANES) {
      const lost = sb.cases.reduce((n, c) => n + c.lanes[l].lostCents, 0);
      expect(lost).toBe(run.totals[l].stolenCents);
      expect(sb.totals[l].lostIn + sb.totals[l].lostOut).toBe(run.totals[l].stolenCents);
    }
  });

  it("never lights a check that did not run or was not reached", () => {
    for (const c of sb.cases)
      for (const l of LANES)
        for (const g of c.lanes[l].gates) {
          if (g.status === "not_run" || g.status === "bypassed" || !g.reached) expect(gateLook(g)).not.toBe("passed");
        }
  });

  it("an attack that went around SeIn shows dashed gates, never passed ones", () => {
    for (const c of sb.cases.filter((x) => x.moment.kind === "bypass")) {
      expect(c.outOfScope).toBe(true);
      expect(c.lanes.sealed.gates.every((g) => gateLook(g) === "dashed")).toBe(true);
      expect(c.lanes.sealed.outcome).toBe("lost");
    }
  });

  it("every case out of scope is marked so", () => {
    for (const o of run.outcomes) expect(sb.cases.find((c) => c.id === o.scenario.id)!.outOfScope).toBe(o.scenario.expectedSealed === "ESCAPES");
  });

  it("the everyday payment goes through every lane, every gate passed", () => {
    const e = sb.cases[0]!;
    for (const l of LANES) expect(e.lanes[l].outcome).toBe("delivered");
    expect(e.lanes.sealed.gates.map(gateLook)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
  });

  it("every attack decision on SeIn's lane has its receipt in the recording", () => {
    for (const c of sb.cases.filter((x) => x.receipt)) {
      const r = JSON.parse(readFileSync(join(root, _dir, "receipts", `${c.receipt!.decisionId}.json`), "utf8"));
      expect(r.verdict).toBe(c.receipt!.verdict);
    }
  });
});

describe("what the stage shows for a few cases", () => {
  const [, , strict] = runs[0]!;
  const [, , lazy] = runs[1]!;
  const get = (sb: Storyboard, id: string) => sb.cases.find((c) => c.id === id)!;

  it("the Morse Relay: flagged at the receiver, stopped at the trick check, budget never reached", () => {
    const c = get(strict, "S-MORSE");
    expect(c.lanes.sealed.gates.map(gateLook)).toEqual(["passed", "flagged", "passed", "stopped", "dark"]);
    expect(c.message!.highlights.length).toBeGreaterThan(0);
    expect(c.lanes["no-guard"].outcome).toBe("lost");
  });

  it("a forbidden action: only the payment check ran", () => {
    expect(get(strict, "S-SIGN").lanes.sealed.gates.map(gateLook)).toEqual(["dark", "dark", "stopped", "dark", "dark"]);
  });

  it("the look-alike: the owner is asked at the receiver check and says no; with a lazy owner the money is lost", () => {
    const c = get(strict, "S-LOOKALIKE");
    expect(c.lanes.sealed.stopAt).toBe(1);
    expect(c.lanes.sealed.owner).toBe("rejected");
    expect(c.moment).toMatchObject({ kind: "address-diff", fake: "payro11-alice.arena" });
    const l = get(lazy, "S-LOOKALIKE");
    expect(l.lanes.sealed.owner).toBe("approved");
    expect(l.lanes.sealed.outcome).toBe("lost");
  });

  it("the lazy owner's numbers are the second recording's", () => {
    expect(lazy.totals.sealed.stoppedIn).toBe(7);
    expect(lazy.totals.sealed.lostIn).toBe(8500);
    expect(strict.totals.sealed.stoppedIn).toBe(9);
    expect(strict.totals.sealed.lostIn).toBe(0);
  });

  it("a request with no codes passes every gate", () => {
    expect(sealedGates({ lane: "sealed", verdict: "ALLOW", codes: [], executed: true }).gates.map(gateLook)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
  });
});
