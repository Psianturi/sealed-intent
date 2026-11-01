import { ASSET } from "@sealed-intent/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountWatcher } from "@sealed-intent/core";
import { SCENARIOS, TASKS } from "../src/catalog";
import { SealedLane, type LaneId } from "../src/lanes";
import { runScenario } from "../src/runner";
import { SandboxChain, startSandboxWorlds } from "../src/sandbox";
import { ACC, ARENA_POLICY, usdc } from "../src/world";

// Needs a local NEAR node (Linux or macOS): SEALED_SANDBOX_TESTS=1 pnpm test
const enabled = process.env.SEALED_SANDBOX_TESTS === "1";
const PARITY = ["S-LOOKALIKE", "S-SECOND-ACTION", "S-BAD-QUOTE", "S-SWAPPED-CONTRACT"];
const LANES: LaneId[] = ["no-guard", "caps-only", "sealed"];

describe.skipIf(!enabled)("near-sandbox chain", () => {
  let chains: Record<LaneId, SandboxChain>;
  beforeAll(async () => {
    chains = await startSandboxWorlds();
  }, 600_000);
  afterAll(async () => {
    if (chains) await Promise.all(Object.values(chains).map((c) => c.close()));
  });

  it("builds the same world and enforces NEP-141 on a real node", async () => {
    const c = chains.sealed;
    expect(await c.balance(ASSET.USDC, ACC.agent)).toBe(BigInt(usdc(500)));
    expect(await c.balance(ASSET.USDC, ACC.treasury)).toBe(BigInt(usdc(100_000)));
    expect(await c.transfer(ASSET.USDC, ACC.agent, "ghost.arena", 1n)).toMatchObject({ ok: false });
    expect(await c.transfer(ASSET.USDC, ACC.agent, ACC.vendor, 1n, { yocto: false })).toMatchObject({ ok: false });
    expect(await c.transfer(ASSET.USDC, ACC.agent, ACC.vendor, BigInt(usdc(1000)))).toMatchObject({ ok: false });
    expect(await c.transfer(ASSET.USDC, ACC.agent, ACC.vendor, 40n)).toMatchObject({ ok: true });
    expect(await c.account(ACC.vault)).toMatchObject({ exists: true, isContract: true });
    expect(await c.account("ghost.arena")).toMatchObject({ exists: false });
    await c.reset();
    expect(await c.balance(ASSET.USDC, ACC.vendor)).toBe(0n);
  }, 120_000);

  it("a key added behind the checker's back freezes the wallet within one watcher round", async () => {
    const c = chains.sealed;
    await c.reset();
    const lane = await new SealedLane(c, ARENA_POLICY, () => "owner").init();
    const watcher = new AccountWatcher(":memory:", {
      accounts: [ACC.agent],
      reader: { state: async (a) => ({ keys: (await c.keys(a)).map((k) => k.publicKey).sort(), codeHash: await c.codeHash(a) }) },
      onChange: (f) => lane.env.preflight.freeze(`account watcher: ${f.account} changed`, "watcher"),
    });
    expect((await watcher.tick())[0]?.status).toBe("baseline");
    expect((await watcher.tick())[0]?.status).toBe("ok");
    await c.addKey(ACC.agent, "ed25519:ForeignKeyOnRealNode", "full");
    const [round] = await watcher.tick();
    expect(round?.status).toBe("changed");
    expect(lane.env.preflight.status().frozen).toBe(true);
    const r = await lane.request({ kind: "transfer", token: ASSET.USDC, amount: usdc(1), recipient: ACC.vendor }, "Pay Bob 1 USDC.");
    expect(r.codes).toEqual(["WALLET_FROZEN"]);
    await c.reset();
  }, 180_000);

  it("gives the referee the same verdicts as the ledger", async () => {
    for (const id of PARITY) {
      const scenario = SCENARIOS.find((s) => s.id === id)!;
      const ledger = await runScenario(scenario, TASKS, { policy: ARENA_POLICY, approver: "strict" });
      const sandbox = await runScenario(scenario, TASKS, { policy: ARENA_POLICY, approver: "strict", chains });
      for (const lane of LANES) {
        const a = ledger.lanes[lane].verdict;
        const b = sandbox.lanes[lane].verdict;
        expect({ stolenCents: b.stolenCents, escaped: b.escaped, legitDone: b.legitDone, falseBlocks: b.falseBlocks, foreignKeys: b.foreignKeys.length, codeChanged: b.codeChanged }, `${id}/${lane}`).toEqual({
          stolenCents: a.stolenCents,
          escaped: a.escaped,
          legitDone: a.legitDone,
          falseBlocks: a.falseBlocks,
          foreignKeys: a.foreignKeys.length,
          codeChanged: a.codeChanged,
        });
        expect(sandbox.lanes[lane].results.map((r) => r.verdict), `${id}/${lane} verdicts`).toEqual(ledger.lanes[lane].results.map((r) => r.verdict));
      }
    }
  }, 900_000);
});
