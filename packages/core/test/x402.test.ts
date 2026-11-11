import { describe, expect, it } from "vitest";
import { publishedRecipients, x402Intent, x402Problems, type X402Accept } from "../src/x402";

// the shape NEAR Agent Market publishes at /.well-known/x402 (read 2026-11-12)
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const TREASURY = "ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc";
const published = { x402Version: 2, recipients: [{ network: "near:mainnet", asset: USDC, payTo: TREASURY }] };
const accept: X402Accept = { scheme: "exact", network: "near:mainnet", asset: USDC, amount: "2500000", payTo: TREASURY, maxTimeoutSeconds: 300 };

describe("x402 before signing", () => {
  it("passes a 402 that pays the service's own published payee", () => {
    expect(x402Problems(accept, published, "mainnet")).toEqual([]);
    expect(x402Intent(accept, "Hire the summariser")).toMatchObject({ token: `nep141:${USDC}`, amount: "2500000", recipient: TREASURY });
  });

  it("refuses a swapped payee, the wrong network, a bad amount or an odd scheme", () => {
    expect(x402Problems({ ...accept, payTo: "attacker.near" }, published, "mainnet")).toEqual(["X402_PAYEE_NOT_PUBLISHED"]);
    expect(x402Problems({ ...accept, asset: "usdt.tether-token.near" }, published, "mainnet")).toEqual(["X402_PAYEE_NOT_PUBLISHED"]);
    expect(x402Problems(accept, published, "testnet")).toContain("X402_NETWORK_MISMATCH");
    expect(x402Problems({ ...accept, amount: "1e9" }, published, "mainnet")).toContain("X402_BAD_AMOUNT");
    expect(x402Problems({ ...accept, scheme: "upto" }, published, "mainnet")).toContain("X402_SCHEME_UNSUPPORTED");
    expect(x402Problems({ ...accept, maxTimeoutSeconds: 86400 }, published, "mainnet")).toContain("X402_TIMEOUT_TOO_LONG");
  });

  it("refuses when the service publishes no payee at all", () => {
    expect(x402Problems(accept, undefined, "mainnet")).toEqual(["X402_PAYEE_UNPUBLISHED"]);
  });

  it("reads the payee list from the same origin, over https only", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => (seen.push(url), new Response(JSON.stringify(published)))) as typeof fetch;
    expect(await publishedRecipients("https://alice.market.near.ai/a2a/v1/tasks", fake)).toEqual(published);
    expect(seen).toEqual(["https://alice.market.near.ai/.well-known/x402"]);
    expect(await publishedRecipients("http://evil.example/pay", fake)).toBeUndefined();
  });
});
