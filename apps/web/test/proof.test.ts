// The proof page's checks must agree with the official 1Click SDK and with near-kit on real evidence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { quoteHash as sdkQuoteHash, verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { verifyNep413Signature } from "near-kit";
import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode, nep413Hash, nonceTime, quoteHash, reviewHashOf, stableJson, verifyNep413, verifyQuote, type QuoteResponse } from "../src/proof-core";

const evidence = join(__dirname, "..", "..", "..", "evidence");
const read = (...p: string[]) => JSON.parse(readFileSync(join(evidence, ...p), "utf8"));
const quote = read("intents", "quote.json") as QuoteResponse;
const approval = read("custody-testnet", "approval", "approval.json");

describe("NEAR Intents quote", () => {
  it("hashes exactly like the official SDK and accepts the real signature", () => {
    expect(quoteHash(quote)).toBe(sdkQuoteHash(quote as never));
    expect(verifyQuoteSignature(quote as never)).toBe(true);
    expect(verifyQuote(quote)).toBe(true);
  });

  it("refuses a quote with one changed digit, like the SDK", () => {
    const changed = structuredClone(quote);
    changed.quote.amountOut = String(BigInt(changed.quote.amountOut) + 1n);
    expect(verifyQuote(changed)).toBe(false);
    expect(verifyQuoteSignature(changed as never)).toBe(false);
  });

  it("agrees with the SDK on a live quote shape too", () => {
    const live = structuredClone(quote);
    live.quoteRequest.dry = false;
    live.quote.deadline = undefined;
    live.quote.depositAddress = "abc";
    expect(quoteHash(live)).toBe(sdkQuoteHash(live as never));
  });

  it("writes JSON the way json-stable-stringify does", () => {
    expect(stableJson({ b: 1, a: [undefined, "x"], c: undefined, d: { z: null, y: true } })).toBe('{"a":[null,"x"],"b":1,"d":{"y":true,"z":null}}');
  });

  it("round-trips base58, leading zeros included", () => {
    const b = Uint8Array.from([0, 0, 7, 255, 1]);
    expect(base58Decode(base58Encode(b))).toEqual(b);
  });
});

describe("NEP-413 owner approval", () => {
  const nonce = Uint8Array.from(Buffer.from(approval.signed.nonce, "base64"));

  it("agrees with near-kit, which the server uses", async () => {
    const kit = (message: string) => verifyNep413Signature(approval.signed, { message, recipient: approval.recipient, nonce }, { nonceValidation: "none" });
    expect(await kit(approval.message)).toBe(true);
    expect(await kit(approval.message + " ")).toBe(false);
    expect(verifyNep413(approval.signed, approval.message + " ", approval.recipient)).toBe(false);
    expect(nep413Hash({ message: approval.message, nonce, recipient: approval.recipient })).toHaveLength(32);
  });

  it("accepts the owner's real signature and nothing else", () => {
    expect(verifyNep413(approval.signed, approval.message, approval.recipient)).toBe(true);
    expect(verifyNep413(approval.signed, approval.message.replace("approve", "reject"), approval.recipient)).toBe(false);
    expect(verifyNep413(approval.signed, approval.message, "another-app")).toBe(false);
  });

  it("ties the message to exactly what the owner was shown", () => {
    expect(reviewHashOf(approval.shownToOwner)).toBe(approval.reviewHash);
    expect(approval.message).toBe(`SeIn approve ${approval.decisionId} ${approval.reviewHash}`);
    expect(reviewHashOf({ ...approval.shownToOwner, amount: "10000000000000000000000000" })).not.toBe(approval.reviewHash);
  });

  it("reads the signing time from the nonce", () => {
    const t = nonceTime(approval.signed.nonce);
    expect(Math.abs(t - Date.parse(approval.shownToOwner.createdAt))).toBeLessThan(10 * 60_000);
  });
});
