// The site and README say a real enclave run is kept as evidence. This holds them to it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex, verifyReceipt, type Disclosure, type Receipt } from "../src";

const dir = join(__dirname, "..", "..", "..", "evidence", "tee");
const load = <T>(name: string) => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;

describe.each(["routine", "tricked"])("evidence: %s", (name) => {
  const { receipt, request, response } = load<{ receipt: Receipt; request: string; response: string }>(`${name}.json`);

  it("is a real enclave answer, bound to verified hardware and to the connection", () => {
    const tee = receipt.tee!;
    expect(tee.kind).toBe("nearai-cloud");
    expect(tee.signatureKind).toBe("provider_tee");
    expect(tee.attestation.tlsBound).toBe(true);
    expect(tee.attestation.quoteVerifiedLocally).toBe(true);
    expect(tee.attestation.tcbStatus).toBe("UpToDate");
    expect(tee.attestation.checks?.every((c) => c.ok)).toBe(true);
    expect(verifyReceipt(receipt).valid).toBe(true);
  });

  it("the published bytes are the ones the enclave signed", () => {
    expect(sha256Hex(request)).toBe(receipt.tee!.requestHash);
    expect(sha256Hex(response)).toBe(receipt.tee!.responseHash);
    const user = JSON.parse((JSON.parse(request) as { messages: { content: string }[] }).messages[1]!.content) as { DECISION_ID: string; INTENT_COMMITMENT: string };
    expect(user.DECISION_ID).toBe(receipt.receiptId);
    expect(user.INTENT_COMMITMENT).toBe(receipt.commitments.intent);
  });

  it("one opened field matches, and a changed value does not", () => {
    const d = load<Disclosure>(`${name}.disclosure.json`);
    expect(verifyReceipt(receipt, { disclosures: [d] }).valid).toBe(true);
    expect(verifyReceipt(receipt, { disclosures: [{ ...d, opening: { ...d.opening, value: "someone-else.near" } }] }).valid).toBe(false);
  });
});

it("the verify page's sample is the evidence, not something else", () => {
  const sample = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "apps", "web", "data", "sample-receipt.json"), "utf8")) as Receipt;
  expect(sample.receiptId).toBe(load<{ receipt: Receipt }>("tricked.json").receipt.receiptId);
});
