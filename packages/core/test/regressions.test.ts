// Regression tests for the defects found in the 1 Nov review.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreflight } from "../src/config";
import type { Executor, ExecutionResult } from "../src/executor";
import { ASSET, DEMO_ACCOUNTS, DEMO_POLICY } from "../src/fixtures";
import type { SwapIntent } from "../src/intent";

const usdc = (d: number) => String(Math.round(d * 1e6));
const intent = (over: Partial<SwapIntent> & Record<string, unknown> = {}) => ({
  kind: "swap" as const, tokenIn: ASSET.USDC, tokenOut: ASSET.wNEAR, amountIn: usdc(45),
  recipient: DEMO_ACCOUNTS.self, refundTo: DEMO_ACCOUNTS.self, purpose: "general", taskText: "Routine treasury task approved by ops.", ...over,
});
const tmp = () => mkdtempSync(join(tmpdir(), "sealed-reg-"));
const build = (opts: { ledgerPath?: string; executor?: Executor } = {}) => {
  const d = tmp();
  return buildPreflight({ offline: true, home: join(d, ".sealed"), outDir: join(d, "out"), ledgerPath: opts.ledgerPath ?? ":memory:", executor: opts.executor });
};
const fixed = (status: ExecutionResult["status"]): Executor => ({ mode: "offline", execute: async () => ({ status, txHash: status === "not_sent" ? undefined : "tx" }) });

describe("budget cannot be bypassed", () => {
  it("ignores an agentId written by the agent; the server-assigned identity is what counts", async () => {
    const env = build();
    let spent = 0;
    for (let i = 0; i < 6; i++) {
      const d = await env.preflight.evaluate({ agentId: "treasury-agent", intent: intent({ agentId: `treasury-agent-${i}` }) });
      if (d.verdict === "ALLOW") {
        await env.preflight.execute(d.decisionId);
        spent += 45;
      }
    }
    expect(spent).toBeLessThanOrEqual(DEMO_POLICY.dailyUsd);
    expect(spent).toBe(90);
  });

  it("keeps the budget spent when the executor cannot confirm the outcome", async () => {
    const env = build({ executor: fixed("unknown") });
    const d = await env.preflight.evaluate({ agentId: "a", intent: intent() });
    expect((await env.preflight.execute(d.decisionId)).status).toBe("unknown");
    expect(env.ledger.used("a", 86_400_000)).toBe(4_500);
  });

  it("keeps the budget spent when the executor throws after sending", async () => {
    const env = build({ executor: { mode: "offline", execute: async () => { throw new Error("socket closed"); } } });
    const d = await env.preflight.evaluate({ agentId: "a", intent: intent() });
    expect((await env.preflight.execute(d.decisionId)).status).toBe("unknown");
    expect(env.ledger.used("a", 86_400_000)).toBe(4_500);
  });

  it("releases the budget only when nothing left the wallet", async () => {
    const env = build({ executor: fixed("not_sent") });
    const d = await env.preflight.evaluate({ agentId: "a", intent: intent() });
    expect((await env.preflight.execute(d.decisionId)).status).toBe("not_sent");
    expect(env.ledger.used("a", 86_400_000)).toBe(0);
  });
});

describe("pending decisions are shared and owned", () => {
  it("a WARN issued by one process can be approved by another and executed by the first", async () => {
    const db = join(tmp(), "state.db");
    const mcp = build({ ledgerPath: db });
    const rest = build({ ledgerPath: db });
    const d = await mcp.preflight.evaluate({ agentId: "a", intent: intent({ recipient: DEMO_ACCOUNTS.newVendor, amountIn: usdc(10) }) });
    expect(d.verdict).toBe("WARN");
    expect(rest.preflight.approve(d.decisionId, "human").ok).toBe(true);
    expect((await mcp.preflight.execute(d.decisionId, "a")).status).toBe("simulated");
    expect((await mcp.preflight.execute(d.decisionId, "a")).status).toBe("not_sent");
  });

  it("another agent cannot execute a decision it did not request", async () => {
    const env = build();
    const d = await env.preflight.evaluate({ agentId: "a", intent: intent({ amountIn: usdc(10) }) });
    expect(d.verdict).toBe("ALLOW");
    const other = await env.preflight.execute(d.decisionId, "b");
    expect(other.status).toBe("not_sent");
    expect(String(other.details)).toContain("another agent");
    expect((await env.preflight.execute(d.decisionId, "a")).status).toBe("simulated");
  });
});
