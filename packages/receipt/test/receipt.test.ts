import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildReceipt,
  canonicalJson,
  expectedSignedText,
  makeDisclosure,
  publicKeyHex,
  recoverEip191Address,
  sha256Hex,
  signEip191,
  verifyReceipt,
  type IssuerKey,
  type TeeEvidence,
} from "../src/index";

function issuer(): IssuerKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKeyHex: publicKeyHex(publicKey) };
}

function teeEvidence(tamper = false): TeeEvidence {
  const priv = randomBytes(32).toString("hex");
  const requestHash = sha256Hex('{"model":"m","messages":[]}');
  const responseHash = sha256Hex('{"id":"chat-1","choices":[]}');
  const base = { signatureKind: "provider_tee" as const, model: "test/model", requestHash, responseHash };
  const text = expectedSignedText(base);
  const { signature, address } = signEip191(text, priv);
  return {
    kind: "offline-simulated",
    ...base,
    text: tamper ? text.replace(/.$/, "0") : text,
    signature,
    signingAddress: address,
    signingAlgo: "ecdsa",
    attestation: { nonce: "00", signingAddressMatched: true, quoteVerifiedLocally: false },
    signal: "allow",
    signalCodes: [],
  };
}

describe("canonical json", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }),
    );
  });
});

describe("eip191", () => {
  it("recovers the signer address", () => {
    const priv = randomBytes(32).toString("hex");
    const { signature, address } = signEip191("hello sealed intent", priv);
    expect(recoverEip191Address("hello sealed intent", signature)).toBe(address);
    expect(recoverEip191Address("hello sealed intent!", signature)).not.toBe(address);
  });
});

describe("receipts", () => {
  const key = issuer();
  const build = (tee?: TeeEvidence) =>
    buildReceipt(
      {
        verdict: "ALLOW",
        reasonCodes: [],
        publicPart: { intentKind: "swap", route: "public", mode: "offline" },
        privateValues: { recipient: "alice.near", amountIn: "2000000" },
        policy: { maxLossBps: 300 },
        tee,
      },
      key,
    );

  it("verifies an untouched receipt", () => {
    const { receipt } = build(teeEvidence());
    const report = verifyReceipt(receipt, { trustedIssuerKeys: [key.publicKeyHex] });
    expect(report.valid).toBe(true);
    expect(report.tee?.signatureValid).toBe(true);
  });

  it("rejects a receipt whose verdict was edited", () => {
    const { receipt } = build();
    const forged = { ...receipt, verdict: "BLOCK" as const };
    expect(verifyReceipt(forged).valid).toBe(false);
  });

  it("rejects tampered TEE evidence", () => {
    const { receipt } = build(teeEvidence(true));
    expect(verifyReceipt(receipt).valid).toBe(false);
  });

  it("hides private fields and discloses one on request", () => {
    const { receipt, openings } = build();
    expect(JSON.stringify(receipt)).not.toContain("alice.near");
    const d = makeDisclosure(openings, "recipient");
    const report = verifyReceipt(receipt, { disclosures: [d] });
    expect(report.valid).toBe(true);
    expect(report.disclosures[0]?.value).toBe("alice.near");
    const lie = { ...d, opening: { ...d.opening, value: "mallory.near" } };
    expect(verifyReceipt(receipt, { disclosures: [lie] }).valid).toBe(false);
  });

  it("flags an untrusted issuer", () => {
    const { receipt } = build();
    expect(verifyReceipt(receipt, { trustedIssuerKeys: [issuer().publicKeyHex] }).valid).toBe(false);
  });
});
