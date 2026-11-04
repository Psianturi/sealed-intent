import { describe, expect, it } from "vitest";
import { checkTransfer, findToken } from "../src/checks";
import { DEMO_POLICY } from "../src/fixtures";
import type { TokenResponse } from "../src/oneclick";

// 1Click's mainnet list has wNEAR but no entry for native NEAR
const tokens: TokenResponse[] = [{ assetId: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, price: 4, blockchain: "near", priceUpdatedAt: "2026-11-04T00:00:00Z" }];
const policy = { ...DEMO_POLICY, allowedAssets: ["native"], perTxUsd: 5 };
const pay = (near: number) => ({ kind: "transfer" as const, token: "native", amount: (BigInt(Math.round(near * 1000)) * 10n ** 21n).toString(), recipient: "bob.near", purpose: "general" });

describe("native NEAR on mainnet", () => {
  it("takes its price from wNEAR", () => {
    expect(findToken(tokens, "native")).toMatchObject({ assetId: "native", symbol: "NEAR", decimals: 24, price: 4 });
  });

  it("is checked against the per-payment limit instead of failing for want of a price", () => {
    expect(checkTransfer({ intent: pay(1) as never, policy, tokens }).block).toEqual([]);
    expect(checkTransfer({ intent: pay(2) as never, policy, tokens }).block).toEqual(["ABOVE_PER_TX_LIMIT"]);
  });

  it("does not let native NEAR pass where only wNEAR is allowed", () => {
    expect(checkTransfer({ intent: pay(1) as never, policy: { ...policy, allowedAssets: ["nep141:wrap.near"] }, tokens }).block).toContain("ASSET_NOT_ALLOWED");
  });
});
