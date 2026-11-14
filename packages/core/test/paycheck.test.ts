import { describe, expect, it } from "vitest";
import { payCheck, type PayFacts } from "../src/paycheck";

const now = Date.parse("2026-11-13T00:00:00Z");
const old = now - 400 * 86_400_000;
const base: PayFacts = { to: "bob-the-builder.near", payer: "alice.near", amountNear: 2, receiver: { exists: true, isContract: false, createdAt: old }, paidBefore: { "bob-the-builder.near": 3, "carol.near": 1 }, pastAmounts: [1, 2, 2, 3, 2, 1], balanceNear: 40, injectionCodes: [], enclave: { signal: "allow", attested: true }, now };
const codes = (f: PayFacts) => payCheck(f).findings.map((x) => x.code);

describe("pay check", () => {
  it("lets a familiar, ordinary payment through and says why", () => {
    const r = payCheck(base);
    expect(r.verdict).toBe("ALLOW");
    expect(r.risk).toBe(0);
    expect(codes(base)).toEqual(expect.arrayContaining(["PAID_BEFORE", "RECEIVER_AGE", "INSTRUCTION_PLAIN"]));
  });

  it("refuses a name that passes for an account the payer has paid", () => {
    const r = payCheck({ ...base, to: "bob-the-bui1der.near" });
    expect(r.verdict).toBe("BLOCK");
    expect(r.findings[0]).toMatchObject({ code: "RECEIVER_LOOKALIKE", level: "block" });
    expect(r.findings[0]!.text).toContain("bob-the-builder.near");
  });

  it("refuses an account that does not exist, but only warns about an unused implicit address", () => {
    expect(payCheck({ ...base, to: "nobody-here.near", receiver: { exists: false, isContract: false } }).verdict).toBe("BLOCK");
    const hex = "a".repeat(64);
    const r = payCheck({ ...base, to: hex, receiver: { exists: false, isContract: false } });
    expect(r.verdict).toBe("WARN");
    expect(r.findings.map((x) => x.code)).toContain("RECEIVER_UNUSED");
  });

  it("asks for a second look at a first payment, a fresh account, or an unusual amount", () => {
    expect(payCheck({ ...base, to: "dave.near" }).verdict).toBe("WARN");
    expect(codes({ ...base, to: "dave.near" })).toContain("NEVER_PAID");
    expect(codes({ ...base, to: "dave.near", receiver: { exists: true, isContract: false, createdAt: now - 2 * 86_400_000 } })).toContain("RECEIVER_NEW");
    expect(payCheck({ ...base, receiver: { exists: true, isContract: false, createdAt: now - 2 * 86_400_000 } })).toMatchObject({ verdict: "ALLOW", risk: 0 });
    expect(codes({ ...base, amountNear: 30 })).toEqual(expect.arrayContaining(["AMOUNT_UNUSUAL", "AMOUNT_HALF_BALANCE"]));
    expect(codes({ ...base, amountNear: 39 })).toContain("AMOUNT_WHOLE_BALANCE");
  });

  it("needs both the screen and the enclave to call a message a trick outright; one alone is a warning", () => {
    expect(payCheck({ ...base, injectionCodes: ["URGENCY"], enclave: { signal: "block", attested: true } }).verdict).toBe("BLOCK");
    expect(payCheck({ ...base, injectionCodes: ["URGENCY"], enclave: { signal: "allow", attested: true } }).verdict).toBe("WARN");
    const stranger = payCheck({ ...base, to: "dave.near", enclave: { signal: "block", attested: true, codes: ["SOCIAL_ENGINEERING"] } });
    expect(stranger.verdict).toBe("WARN");
    expect(stranger.findings.find((x) => x.code === "ENCLAVE_OBJECTS")!.text).toContain("claims authority");
  });

  it("says what it could not see instead of guessing", () => {
    const r = payCheck({ to: "dave.near", injectionCodes: [], now });
    expect(r.verdict).toBe("WARN");
    expect(r.findings.map((x) => x.code)).toEqual(expect.arrayContaining(["RECEIVER_UNKNOWN", "NO_PAYER"]));
    expect(codes({ ...base, paidBefore: undefined })).toContain("HISTORY_UNREAD");
    expect(payCheck({ ...base, paidBefore: undefined }).verdict).toBe("WARN");
    expect(payCheck({ ...base, paidBefore: {} }).findings.map((x) => x.code)).toContain("NO_HISTORY");
  });

  it("does not let the model's doubt alone outweigh a receiver the payer already pays", () => {
    const r = payCheck({ ...base, enclave: { signal: "block", attested: true, codes: ["INTENT_QUOTE_MISMATCH"] } });
    expect(r.verdict).toBe("ALLOW");
    expect(r.risk).toBe(15);
    expect(r.findings.find((x) => x.code === "ENCLAVE_NOTE")).toMatchObject({ level: "info" });
    expect(r.findings.find((x) => x.code === "ENCLAVE_NOTE")!.text).toContain("does not clearly name");
    // with anything else wrong, the same doubt counts in full
    expect(payCheck({ ...base, amountNear: 30, enclave: { signal: "block", attested: true } }).findings.map((x) => x.code)).toContain("ENCLAVE_OBJECTS");
  });

  it("says a few words are too short to judge instead of guessing", () => {
    const r = payCheck({ ...base, messageShort: true, enclave: undefined });
    expect(r.verdict).toBe("ALLOW");
    expect(r.findings.map((x) => x.code)).toContain("MESSAGE_SHORT");
  });
});
