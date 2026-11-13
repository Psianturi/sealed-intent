import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreflight } from "../src/config";
import { ASSET, DEMO_ACCOUNTS, DEMO_POLICY } from "../src/fixtures";
import { imitates } from "../src/lookalike";

const trusted = ["payroll-alice.near", "vendor.testnet", "a1b2" + "0".repeat(56) + "c3d4"];

describe("look-alike receivers", () => {
  it("catches swapped characters, near misses, a trusted name tucked inside another, and matching ends of implicit accounts", () => {
    expect(imitates("payroll-a1ice.near", trusted)).toBe("payroll-alice.near");
    expect(imitates("payrol-alice.near", trusted)).toBe("payroll-alice.near");
    expect(imitates("payroll-alice-near.near", trusted)).toBe("payroll-alice.near");
    expect(imitates("a1b2" + "f".repeat(56) + "c3d4", trusted)).toBe(trusted[2]);
  });

  it("leaves trusted accounts, their sub-accounts and unrelated names alone", () => {
    expect(imitates("payroll-alice.near", trusted)).toBeUndefined();
    expect(imitates("invoices.payroll-alice.near", trusted)).toBeUndefined();
    expect(imitates("bob.near", trusted)).toBeUndefined();
    expect(imitates("ffff" + "0".repeat(56) + "c3d4", trusted)).toBeUndefined();
  });

  it("is not fooled by a shared parent: anyone can register a name under a public registrar", () => {
    expect(imitates("payroll-a1ice.near", [...trusted, "near"])).toBe("payroll-alice.near");
    expect(imitates("hos-r00t.sputnik-dao.near", ["sputnik-dao.near", "hos-root.sputnik-dao.near"])).toBe("hos-root.sputnik-dao.near");
  });

  const run = async (policy = DEMO_POLICY) => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-like-"));
    const env = buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: ":memory:", policy });
    return env.preflight.evaluate({ agentId: "agent-1", intent: { kind: "transfer", token: ASSET.USDC, amount: "5000000", recipient: "payroll-a1ice.near", purpose: "payroll", taskText: "Pay Alice her salary." } as never });
  };

  it("is refused outright when the policy turns the rule on", async () => {
    const d = await run({ ...DEMO_POLICY, lookalikeRecipient: "block" });
    expect(d.verdict).toBe("BLOCK");
    expect(d.reasonCodes).toContain("RECIPIENT_LOOKALIKE");
  });

  it("is off unless the policy asks for it, so recorded runs keep their verdicts", async () => {
    const d = await run();
    expect([...d.reasonCodes, ...d.warnCodes]).not.toContain("RECIPIENT_LOOKALIKE");
    expect(DEMO_ACCOUNTS.payroll).toBe("payroll-alice.near");
  });
});
