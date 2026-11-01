// Finding 8: receipts are bound to the TEE request and to the execution.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, verifyExecutionReceipt, verifyReceipt, type ExecutionReceipt, type Receipt } from "@sealed-intent/receipt";
import { describe, expect, it } from "vitest";
import { buildPreflight } from "../src/config";
import { ASSET, DEMO_ACCOUNTS } from "../src/fixtures";

const usdc = (d: number) => String(Math.round(d * 1e6));
const swap = { kind: "swap", tokenIn: ASSET.USDC, tokenOut: ASSET.wNEAR, amountIn: usdc(10), recipient: DEMO_ACCOUNTS.self, refundTo: DEMO_ACCOUNTS.self };

describe("receipt binding", () => {
  const dir = mkdtempSync(join(tmpdir(), "sealed-bind-"));
  const env = buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: ":memory:" });

  it("the enclave's signed request names the receipt it belongs to", async () => {
    const d = await env.preflight.evaluate({ agentId: "a", intent: swap });
    const receipt = JSON.parse(readFileSync(d.receiptPath, "utf8")) as Receipt;
    const raw = JSON.parse(readFileSync(join(dir, ".sealed", "tee", `${d.decisionId}.json`), "utf8")) as { request: string; response: string };
    expect(receipt.tee?.requestHash).toBe(sha256Hex(raw.request));
    expect(receipt.tee?.responseHash).toBe(sha256Hex(raw.response));
    const userMessage = JSON.parse((JSON.parse(raw.request) as { messages: { content: string }[] }).messages[1]!.content) as { DECISION_ID: string };
    expect(userMessage.DECISION_ID).toBe(d.decisionId);
    expect(raw.request).toContain(DEMO_ACCOUNTS.self);
    expect(readFileSync(d.receiptPath, "utf8")).not.toContain(DEMO_ACCOUNTS.self);
  });

  it("execution produces a signed receipt naming the decision and the transaction", async () => {
    const d = await env.preflight.evaluate({ agentId: "a", intent: swap });
    const x = await env.preflight.execute(d.decisionId, "a");
    expect(x.status).toBe("simulated");
    const path = join(dir, "out", "receipts", `${x.executionReceiptId}.json`);
    expect(existsSync(path)).toBe(true);
    const rec = JSON.parse(readFileSync(path, "utf8")) as ExecutionReceipt;
    expect(rec.decisionId).toBe(d.decisionId);
    expect(rec.txHash).toBe(x.txHash);
    expect(verifyExecutionReceipt(rec).valid).toBe(true);
    expect(verifyExecutionReceipt({ ...rec, txHash: "sim-forged" }).valid).toBe(false);
    expect(verifyReceipt(JSON.parse(readFileSync(d.receiptPath, "utf8"))).valid).toBe(true);
  });
});
