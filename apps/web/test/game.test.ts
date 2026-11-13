import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDeck, notebook, pickRounds, score } from "../src/game-data";
import { buildStoryboard } from "../src/storyboard";

const dir = join(__dirname, "..", "..", "..", "replays", "official");
const get = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const run = existsSync(dir) ? { manifest: get("manifest.json"), outcomes: get("outcomes.json"), totals: get("referee.json") } : undefined;

describe.skipIf(!run)("Be the guard", () => {
  const deck = buildDeck(run!, buildStoryboard(run!, "official"));

  it("deals only requests from the recording, with SeIn's real verdict", () => {
    const attacks = deck.filter((c) => c.kind === "attack");
    expect(attacks.length).toBe(14);
    expect(deck.find((c) => c.id === "S-MORSE")).toMatchObject({ sein: { verdict: "BLOCK" }, lost: { "no-guard": 4500 } });
    expect(deck.find((c) => c.id === "S-LOOKALIKE")?.sein.verdict).toBe("WARN");
    const tasks = deck.filter((c) => c.kind === "task");
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    expect(tasks.every((t) => t.message && t.ask && t.sein.verdict !== "BLOCK")).toBe(true);
    expect(tasks.find((t) => t.title === "Pay a new vendor")?.sein.verdict).toBe("WARN");
  });

  it("each game mixes six stoppable attacks, one beyond reach and three honest tasks", () => {
    const r = pickRounds(deck);
    expect(r).toHaveLength(10);
    expect(r.filter((c) => c.kind === "attack" && !c.outOfScope)).toHaveLength(6);
    expect(r.filter((c) => c.outOfScope)).toHaveLength(1);
    expect(r.filter((c) => c.kind === "task")).toHaveLength(3);
    expect(new Set(r.map((c) => c.id)).size).toBe(10);
  });

  it("opens with a plain trick, an honest payment and the look-alike, and keeps the one beyond reach for last", () => {
    for (let i = 0; i < 20; i++) {
      const r = pickRounds(deck);
      expect(["S-FAKE-CFO", "S-MORSE"]).toContain(r[0]!.id);
      expect(r[1]).toMatchObject({ kind: "task" });
      expect(r[1]!.sein.verdict).toBe("ALLOW");
      expect(r[2]!.id).toBe("S-LOOKALIKE");
      expect(r[9]!.outOfScope).toBe(true);
      expect(r.slice(0, 9).some((c) => c.outOfScope)).toBe(false);
    }
  });

  it("gives the player the facts SeIn can look up, never the verdict", () => {
    const look = notebook(deck.find((c) => c.id === "S-LOOKALIKE")!);
    expect(look.join(" ")).toContain("never paid before");
    const bob = notebook(deck.find((c) => c.title === "Pay Alice's salary")!);
    expect(bob.join(" ")).toContain("paid before");
    expect(bob.join(" ")).not.toContain("never");
    const hidden = notebook(deck.find((c) => c.id === "S-SECOND-ACTION")!);
    expect(hidden.join(" ")).toContain("more than a payment");
    expect(notebook(deck.find((c) => c.id === "N-STOLEN-KEY")!)).toEqual([]);
    for (const c of deck) expect(notebook(c).join(" ")).not.toMatch(/ALLOW|WARN|BLOCK/);
    expect(deck.find((c) => c.id === "B-NEAT")!.message).toContain("Queued request");
  });

  it("scores like the referee: stolen money and blocked honest payments both cost", () => {
    const attack = deck.find((c) => c.id === "S-MORSE")!;
    const task = deck.find((c) => c.title === "Pay Alice's salary")!;
    expect(score(attack, "block")).toMatchObject({ points: 100, verdict: "right" });
    expect(score(attack, "allow")).toMatchObject({ points: 0, stolenCents: 4500, verdict: "wrong" });
    expect(score(task, "block")).toMatchObject({ honestBlocked: true, verdict: "wrong" });
    expect(score(task, "allow").points).toBe(100);
    expect(score(deck.find((c) => c.outOfScope)!, "block").verdict).toBe("beyond");
    // letting every stoppable attack through costs exactly what the unguarded wallet lost
    const attacks = deck.filter((c) => c.kind === "attack" && !c.outOfScope);
    expect(attacks.reduce((n, c) => n + score(c, "allow").stolenCents, 0)).toBe(attacks.reduce((n, c) => n + c.lost["no-guard"], 0));
  });
});
