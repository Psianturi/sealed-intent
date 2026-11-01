// The browser verifier must agree with the Node verifier on real receipts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReceipt as nodeVerify } from "@sealed-intent/receipt";
import { describe, expect, it } from "vitest";
import { verifyExecution, verifyReceipt } from "../src/verify-core";

const dir = join(__dirname, "..", "..", "..", "out", "receipts");
const files = (() => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
  } catch {
    return [];
  }
})();
const receipts = files.filter((r) => r.version === "sealed-intent/receipt@1");
const executions = files.filter((r) => r.version === "sealed-intent/execution@1");

describe.skipIf(receipts.length === 0)("browser verifier", () => {
  it("accepts every receipt the Node verifier accepts, and rejects edits", () => {
    for (const r of receipts.slice(0, 20)) {
      expect(nodeVerify(r).valid).toBe(true);
      expect(verifyReceipt(r, "").valid).toBe(true);
      expect(verifyReceipt({ ...r, verdict: r.verdict === "ALLOW" ? "BLOCK" : "ALLOW" }, "").valid).toBe(false);
      expect(verifyReceipt(r, "00".repeat(32)).valid).toBe(false);
      expect(verifyReceipt(r, r.issuer.publicKey).valid).toBe(true);
    }
  });

  it("accepts execution receipts and rejects a changed tx hash", () => {
    for (const x of executions.slice(0, 5)) {
      expect(verifyExecution(x, "").valid).toBe(true);
      expect(verifyExecution({ ...x, txHash: "forged" }, "").valid).toBe(false);
    }
  });
});
