import { describe, expect, it } from "vitest";
import { lessonFrom, lookalikeOf, safeToCut, scan, skeleton, type AccessKey, type ScanInput } from "../src/checkup-core";

const fc = (receiver: string, key = `ed25519:${receiver}`): AccessKey => ({ public_key: key, access_key: { nonce: 1, permission: { FunctionCall: { allowance: "250000000000000000000000", receiver_id: receiver, method_names: [] } } } });
const fullKey = (k: string): AccessKey => ({ public_key: k, access_key: { nonce: 1, permission: "FullAccess" } });
const base: ScanInput = { network: "mainnet", account: "alice.near", exists: true, codeHash: "11111111111111111111111111111111", keys: [fullKey("ed25519:a")], missing: [], tokens: [], nfts: [], pools: [], contacts: [], flagged: [] };

describe("look-alike names", () => {
  it("catches names that only look like a known contract", () => {
    expect(lookalikeOf("wrap-near.near", "mainnet")).toBe("wrap.near");
    expect(lookalikeOf("v2.ref-flnance.near", "mainnet")).toBe("v2.ref-finance.near");
    expect(lookalikeOf("usdt.tether-t0ken.near", "mainnet")).toBe("usdt.tether-token.near");
    expect(skeleton("socia1.near")).toBe(skeleton("social.near"));
  });

  it("leaves the real ones and their sub-accounts alone", () => {
    for (const ok of ["wrap.near", "social.near", "app.social.near", "bob.near", "ref-finance.near.example"]) expect(lookalikeOf(ok, "mainnet")).toBeUndefined();
  });
});

describe("the check-up", () => {
  it("calls a plain wallet healthy", () => {
    const r = scan({ ...base, keys: [fullKey("ed25519:a"), fc("social.near")] });
    expect(r.grade).toBe("Healthy");
    expect(r.findings.filter((f) => f.heal)).toEqual([]);
  });

  it("flags look-alike, reported and dead connections for cutting, and never a full-access key", () => {
    const r = scan({ ...base, keys: [fullKey("ed25519:a"), fullKey("ed25519:b"), fc("wrap-near.near"), fc("drainer.near"), fc("gone.near"), fc("social.near")], missing: ["gone.near"], flagged: [{ account: "drainer.near", network: "mainnet", reason: "Drained wallets", source: "test" }] });
    const heal = r.findings.filter((f) => f.heal).map((f) => f.target);
    expect(heal.sort()).toEqual(["drainer.near", "gone.near", "wrap-near.near"]);
    expect(r.findings.filter((f) => f.heal).every((f) => f.key && !["ed25519:a", "ed25519:b"].includes(f.key))).toBe(true);
    expect(r.grade).toBe("At risk");
  });

  it("warns about bait NFTs, look-alike tokens and contacts", () => {
    const r = scan({ ...base, tokens: ["usdt.tether-t0ken.near", "wrap.near"], nfts: ["free-membership.near"], contacts: ["socia1.near", "bob.near"] });
    expect(r.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["token:usdt.tether-t0ken.near", "nfts", "contact:socia1.near"]));
  });

  it("says plainly when the account does not exist", () => {
    expect(scan({ ...base, exists: false }).findings[0]!.title).toMatch(/does not exist/);
  });

  it("turns what it found into lessons for the agent", () => {
    const input = { ...base, keys: [fullKey("ed25519:a"), fc("wrap-near.near")], nfts: ["bait.near"] };
    const l = lessonFrom(input, scan(input), new Date("2026-11-07T00:00:00Z"));
    expect(l.neverPay.map((n) => n.account)).toEqual(["wrap-near.near"]);
    expect(l.rules.join(" ")).toMatch(/NFT/);
    expect(l.rules.join(" ")).toMatch(/wrap-near\.near/);
  });
});

describe("the last check before cutting", () => {
  const keys = [fullKey("ed25519:full"), fc("app.near", "ed25519:app"), fc("other.near", "ed25519:other")];
  it("lets through login keys that still exist", () => {
    expect(safeToCut(["ed25519:app", "ed25519:app"], keys)).toEqual({ ok: true, keys: ["ed25519:app"] });
  });
  it("never deletes a full-access key, even if the page was tampered with", () => {
    expect(safeToCut(["ed25519:app", "ed25519:full"], keys)).toMatchObject({ ok: false, reason: expect.stringMatching(/full-access/) });
  });
  it("stops when the keys changed since the scan, or nothing was picked", () => {
    expect(safeToCut(["ed25519:gone"], keys).ok).toBe(false);
    expect(safeToCut([], keys).ok).toBe(false);
  });
});

describe("fair to ordinary wallets", () => {
  it("knows the sub-accounts of a known app, without changing the list for the next scan", () => {
    const r = scan({ ...base, keys: [fullKey("ed25519:a"), fc("boostfarm.ref-labs.near")] });
    expect(r.findings.find((f) => f.target === "boostfarm.ref-labs.near")?.severity).toBe("ok");
    expect(scan({ ...base, keys: [fullKey("ed25519:a"), fc("other.near")] }).findings.find((f) => f.target === "other.near")?.severity).toBe("caution");
  });
  it("treats NFTs from an app the wallet uses as expected, and reward-named ones as bait", () => {
    const r = scan({ ...base, keys: [fullKey("ed25519:a"), fc("aa-harvest-moon.near")], nfts: ["aa-harvest-moon-relics.near", "claim-rewards.near", "art.near"] });
    expect(r.findings.find((f) => f.id === "nfts")?.detail).toMatch(/^claim-rewards\.near\./);
    expect(r.findings.find((f) => f.id === "nfts-other")?.severity).toBe("info");
  });
});
