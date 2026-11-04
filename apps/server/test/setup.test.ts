import { describe, expect, it } from "vitest";
import { agentFiles, mergeEnv, policyFrom, readEnv, tokenOf, toSmallest, type Answers } from "../src/setup";

const answers: Answers = { network: "mainnet", owner: "posma.near", wallet: "ab".repeat(32), perPaymentUsd: 5, dailyUsd: 20, receivers: ["shop.near"], newReceiver: "warn", tokens: ["NEAR", "usdc"], enclave: true };

describe("pnpm sein setup", () => {
  it("turns a few answers into a full policy with careful defaults", () => {
    const p = policyFrom(answers);
    expect(p.allowedAssets).toEqual(["native", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"]);
    expect(p.allowedRecipients).toEqual(["shop.near", "posma.near"]);
    expect(p.ownAccounts).toContain(answers.wallet);
    expect([p.perTxUsd, p.dailyUsd, p.unknownRecipient]).toEqual([5, 20, "warn"]);
    expect(p.tee.required).toBe(true);
    expect(p.actions.never).toContain("add_key");
  });

  it("works with no receivers and refuses unknown tokens", () => {
    expect(policyFrom({ ...answers, receivers: [] }).allowedRecipients).toEqual(["posma.near"]);
    expect(() => policyFrom({ ...answers, tokens: ["DOGE"] })).toThrow(/unknown token/);
    expect(policyFrom({ ...answers, network: "testnet", tokens: ["wNEAR"] }).allowedAssets).toEqual(["nep141:wrap.testnet"]);
  });

  it("updates .env without losing other lines", () => {
    const before = "# mine\nKEEP=1\nOUTLAYER_API_KEY=old\n";
    const after = mergeEnv(before, { OUTLAYER_API_KEY: "new", SEALED_MODE: "live" });
    expect(after).toBe("# mine\nKEEP=1\nOUTLAYER_API_KEY=new\nSEALED_MODE=live\n");
    expect(readEnv(after)).toEqual({ KEEP: "1", OUTLAYER_API_KEY: "new", SEALED_MODE: "live" });
  });
});

describe("amounts in plain units", () => {
  it("converts exactly, without floating point", () => {
    expect(toSmallest("0.1", 24)).toBe("100000000000000000000000");
    expect(toSmallest("12.5", 6)).toBe("12500000");
    expect(toSmallest("3", 6)).toBe("3000000");
  });

  it("refuses what is not a plain positive amount", () => {
    for (const bad of ["1e3", "-1", "0", "0.0000001", "", "1,5", "abc"]) expect(() => toSmallest(bad, 6)).toThrow();
  });

  it("knows the tokens by name on each network", () => {
    expect(tokenOf("mainnet", "near")).toEqual({ assetId: "native", decimals: 24 });
    expect(tokenOf("testnet", "USDC")?.assetId).toBe("nep141:usdc.fakes.testnet");
    expect(tokenOf("mainnet", "BTC")).toBeUndefined();
  });
});

describe("pnpm sein connect", () => {
  it("writes settings that hold only the agent's own access, never SeIn's secrets", () => {
    const files = agentFiles({ name: "shop-bot", restUrl: "http://127.0.0.1:8787", token: "t".repeat(64), signingKey: "s".repeat(64), network: "mainnet", node: "/usr/bin/node", tsx: "/repo/tsx.mjs", bridge: "/repo/mcp-agent.ts" });
    const mcp = JSON.parse(files["mcp.json"]!).mcpServers.sein;
    expect(mcp.command).toBe("/usr/bin/node");
    expect(Object.keys(mcp.env).sort()).toEqual(["SEALED_AGENT_SIGNING_KEY", "SEALED_AGENT_TOKEN", "SEALED_NETWORK", "SEALED_REST_URL"]);
    expect(JSON.parse(files["vscode-mcp.json"]!).servers.sein.type).toBe("stdio");
    expect(files["claude-code.txt"]).toMatch(/^claude mcp add-json sein '/);
    for (const text of Object.values(files)) expect(text).not.toMatch(/OUTLAYER_API_KEY|SEALED_POLICY_KEY|SEALED_OWNER_TOKEN|NEARAI_API_KEY/);
  });
});
