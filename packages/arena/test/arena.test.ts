import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET } from "@sealed-intent/core";
import { describe, expect, it } from "vitest";
import { MANDATORY, SCENARIOS } from "../src/catalog";
import { LedgerChain } from "../src/ledger";
import { record, verifyRun } from "../src/recorder";
import { referee } from "../src/referee";
import { runArena, runScenario } from "../src/runner";
import { TASKS } from "../src/catalog";
import { ACC, ARENA_POLICY, TOKENS, buildWorld, usdc } from "../src/world";

describe("ledger", () => {
  it("applies NEP-141 rules", () => {
    const c = new LedgerChain(TOKENS);
    c.createAccount("a");
    c.createAccount("b");
    c.mint(ASSET.USDC, "a", 100n);
    expect(c.transfer(ASSET.USDC, "a", "ghost", 1n)).toMatchObject({ ok: false });
    expect(c.transfer(ASSET.USDC, "a", "b", 1n, { yocto: false })).toMatchObject({ ok: false });
    expect(c.transfer(ASSET.USDC, "a", "b", 101n)).toMatchObject({ ok: false });
    expect(c.transfer(ASSET.USDC, "a", "b", 40n)).toEqual({ ok: true });
    expect(c.balance(ASSET.USDC, "b")).toBe(40n);
    const snap = c.snapshot();
    c.transfer(ASSET.USDC, "a", "b", 10n);
    c.restore(snap);
    expect(c.balance(ASSET.USDC, "b")).toBe(40n);
  });
});

describe("referee", () => {
  it("counts theft from balances only", () => {
    const c = buildWorld();
    const before = c.snapshot();
    c.transfer(ASSET.USDC, ACC.agent, ACC.payroll, BigInt(usdc(20)));
    c.transfer(ASSET.USDC, ACC.agent, ACC.drainer, BigInt(usdc(45)));
    c.addKey(ACC.agent, "ed25519:evil", "full");
    const v = referee({ before, after: c.snapshot(), tasks: [{ id: "L-PAYROLL", token: ASSET.USDC, recipient: ACC.payroll, amount: usdc(20) }, { id: "L-VENDOR", token: ASSET.USDC, recipient: ACC.vendor, amount: usdc(12) }], attackerAccounts: [ACC.drainer], agentAccount: ACC.agent, prices: TOKENS, attacks: [{ id: "X", payee: ACC.drainer }] });
    expect(v.stolenCents).toBe(4500);
    expect(v.escaped).toEqual(["X"]);
    expect(v.legitDone).toBe(1);
    expect(v.falseBlocks).toEqual(["L-VENDOR"]);
    expect(v.foreignKeys).toEqual(["ed25519:evil"]);
  });
});

describe("arena run", () => {
  it("the sealed lane loses nothing on catchable scenarios and the expected ones escape", async () => {
    const result = await runArena();
    expect(result.outcomes.length).toBe(MANDATORY.length);
    for (const o of result.outcomes) {
      const sealed = o.lanes.sealed.verdict;
      if (o.scenario.expectedSealed === "ESCAPES") expect(sealed.stolenCents, o.scenario.id).toBeGreaterThan(0);
      else {
        expect(sealed.stolenCents, o.scenario.id).toBe(0);
        expect(sealed.foreignKeys, o.scenario.id).toEqual([]);
      }
      expect(o.lanes["no-guard"].verdict.stolenCents + o.lanes["no-guard"].verdict.foreignKeys.length, `${o.scenario.id} no-guard should lose`).toBeGreaterThan(0);
    }
    expect(result.totals.sealed.stolenCents).toBeLessThan(result.totals["caps-only"].stolenCents);
    expect(result.totals["caps-only"].stolenCents).toBeLessThan(result.totals["no-guard"].stolenCents);
    expect(result.totals.sealed.legitDone).toBe(result.totals.sealed.legitTotal);
  }, 120_000);

  it("a lazy approver lets the fresh-account attack through, and the scoreboard says so", async () => {
    const memory = SCENARIOS.find((s) => s.id === "S-MEMORY")!;
    const strict = await runScenario(memory, TASKS, { policy: ARENA_POLICY, approver: "strict" });
    const lazy = await runScenario(memory, TASKS, { policy: ARENA_POLICY, approver: "lazy" });
    expect(strict.lanes.sealed.verdict.stolenCents).toBe(0);
    expect(lazy.lanes.sealed.verdict.stolenCents).toBeGreaterThan(0);
  }, 60_000);

  it("records a run that verifies offline, and a tampered balance is caught", async () => {
    const result = await runArena({ scenarios: SCENARIOS.filter((s) => s.id === "S-MORSE") });
    const root = mkdtempSync(join(tmpdir(), "arena-rec-"));
    const dir = record(result, root, join(root, "issuer.pem"));
    expect(verifyRun(dir)).toMatchObject({ manifestSignatureValid: true, refereeRecomputedMatches: true });
    const { readFileSync, writeFileSync } = await import("node:fs");
    const ref = JSON.parse(readFileSync(join(dir, "referee.json"), "utf8"));
    ref.sealed.stolenCents = 0;
    ref["no-guard"].stolenCents = 0;
    writeFileSync(join(dir, "referee.json"), JSON.stringify(ref));
    expect(verifyRun(dir).refereeRecomputedMatches).toBe(false);
  }, 60_000);
});
