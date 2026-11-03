// Action classes (F1), contract method allow-list (F4) and persistent freeze (F3).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreflight } from "../src/config";
import { ASSET, DEMO_ACCOUNTS, DEMO_POLICY } from "../src/fixtures";
import type { Policy } from "../src/policy";

const usdc = (d: number) => String(Math.round(d * 1e6));
const NEAR = (n: number) => `${n}000000000000000000000000`;
const build = (policy: Policy = DEMO_POLICY, ledgerPath = ":memory:") => {
  // processes sharing a database share one data key
  const d = ledgerPath === ":memory:" ? mkdtempSync(join(tmpdir(), "sealed-act-")) : dirname(ledgerPath);
  return buildPreflight({ offline: true, home: join(d, ".sealed"), outDir: join(d, "out"), ledgerPath, policy });
};
const swap = { kind: "swap", tokenIn: ASSET.USDC, tokenOut: ASSET.wNEAR, amountIn: usdc(10), recipient: DEMO_ACCOUNTS.self, refundTo: DEMO_ACCOUNTS.self, taskText: "Routine treasury task approved by ops." };
const ev = (env: ReturnType<typeof build>, intent: unknown) => env.preflight.evaluate({ agentId: "a", intent: { taskText: "Routine treasury task approved by ops.", ...(intent as object) } });

describe("forbidden action classes freeze the wallet", () => {
  it.each(["add_key", "deploy", "sign_message", "delete_account"])("%s is refused and the wallet freezes until the owner lifts it", async (kind) => {
    const env = build();
    const d = await ev(env, { kind, details: { publicKey: "ed25519:attacker" } });
    expect(d.verdict).toBe("BLOCK");
    expect(d.reasonCodes).toEqual(["ACTION_CLASS_FORBIDDEN"]);
    expect(env.preflight.status().frozen).toBe(true);
    expect((await ev(env, swap)).reasonCodes).toEqual(["WALLET_FROZEN"]);
    expect(env.preflight.unfreeze("owner")).toBe(true);
    expect((await ev(env, swap)).verdict).toBe("ALLOW");
  });

  it("a frozen wallet also refuses to execute decisions made earlier", async () => {
    const env = build();
    const d = await ev(env, swap);
    expect(d.verdict).toBe("ALLOW");
    env.preflight.freeze("owner pressed the kill switch", "owner");
    expect((await env.preflight.execute(d.decisionId, "a")).status).toBe("not_sent");
  });

  it("freeze survives a restart (new instance on the same database)", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "sealed-frz-")), "state.db");
    const first = build(DEMO_POLICY, db);
    await ev(first, { kind: "add_key" });
    const second = build(DEMO_POLICY, db);
    expect(second.preflight.status().frozen).toBe(true);
    expect((await ev(second, swap)).reasonCodes).toEqual(["WALLET_FROZEN"]);
  });

  it("a burst of blocks freezes the wallet", async () => {
    const env = build({ ...DEMO_POLICY, freeze: { onForbiddenAction: true, maxBlocksPerHour: 3, maxLimitProbesPerDay: 6 } });
    for (let i = 0; i < 3; i++) await ev(env, { ...swap, recipient: DEMO_ACCOUNTS.attacker });
    expect(env.preflight.status().frozen).toBe(true);
    expect(env.preflight.status().reason).toContain("3 blocks");
  });
});

describe("transfer", () => {
  it("pays an allow-listed account with an allowed token", async () => {
    const env = build();
    const d = await ev(env, { kind: "transfer", token: ASSET.USDC, amount: usdc(20), recipient: DEMO_ACCOUNTS.payroll, purpose: "payroll" });
    expect(d.verdict).toBe("ALLOW");
    expect((await env.preflight.execute(d.decisionId, "a")).status).toBe("simulated");
    expect(env.ledger.used("a", 3_600_000)).toBe(2_000);
  });

  it("blocks oversize, look-alike token and blocklisted recipient", async () => {
    const env = build();
    expect((await ev(env, { kind: "transfer", token: ASSET.USDC, amount: usdc(80), recipient: DEMO_ACCOUNTS.payroll })).detailCodes).toContain("ABOVE_PER_TX_LIMIT");
    expect((await ev(env, { kind: "transfer", token: ASSET.FAKE_USDC, amount: usdc(5), recipient: DEMO_ACCOUNTS.payroll })).reasonCodes).toContain("LOOKALIKE_ASSET");
    expect((await ev(env, { kind: "transfer", token: ASSET.USDC, amount: usdc(5), recipient: DEMO_ACCOUNTS.attacker })).reasonCodes).toContain("COUNTERPARTY_BLOCKLISTED");
  });
});

describe("call", () => {
  it("allows an allow-listed method under the deposit cap", async () => {
    const env = build();
    const d = await ev(env, { kind: "call", contract: DEMO_ACCOUNTS.pool, method: "deposit", args: { note: "weekly" }, depositYocto: "500000000000000000000000" });
    expect(d.verdict).toBe("ALLOW");
    expect((await env.preflight.execute(d.decisionId, "a")).status).toBe("simulated");
  });

  it("blocks owner methods, unknown contracts and deposits above the cap", async () => {
    const env = build();
    expect((await ev(env, { kind: "call", contract: DEMO_ACCOUNTS.pool, method: "withdraw_all" })).reasonCodes).toEqual(["METHOD_NOT_ALLOWED"]);
    expect((await ev(env, { kind: "call", contract: DEMO_ACCOUNTS.upgradedContract, method: "deposit" })).reasonCodes).toContain("CONTRACT_NOT_ALLOWED");
    expect((await ev(env, { kind: "call", contract: DEMO_ACCOUNTS.pool, method: "deposit", depositYocto: NEAR(2) })).reasonCodes).toEqual(["DEPOSIT_TOO_LARGE"]);
  });
});
