// The pieces of `pnpm sein` that need no network or prompt, so they can be tested.
import { DEMO_POLICY, Policy } from "@sealed-intent/core";

export type Network = "mainnet" | "testnet";

/** Tokens an owner can name in plain words, per network. */
export const TOKENS: Record<Network, Record<string, { assetId: string; decimals: number }>> = {
  mainnet: {
    NEAR: { assetId: "native", decimals: 24 },
    WNEAR: { assetId: "nep141:wrap.near", decimals: 24 },
    USDC: { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
  },
  testnet: {
    NEAR: { assetId: "native", decimals: 24 },
    WNEAR: { assetId: "nep141:wrap.testnet", decimals: 24 },
    USDC: { assetId: "nep141:usdc.fakes.testnet", decimals: 6 },
  },
};

export const OUTLAYER_URL: Record<Network, string> = { mainnet: "https://api.outlayer.ai", testnet: "https://testnet-api.outlayer.ai" };
export const OUTLAYER_CONTRACT: Record<Network, string> = { mainnet: "outlayer.near", testnet: "outlayer.testnet" };
export const RPC_URL: Record<Network, string> = { mainnet: "https://free.rpc.fastnear.com", testnet: "https://test.rpc.fastnear.com" };

export function tokenOf(network: Network, symbol: string): { assetId: string; decimals: number } | undefined {
  return TOKENS[network][symbol.trim().toUpperCase()];
}

/** "0.25" with 24 decimals becomes "250000000000000000000000". Refuses anything that is not a plain positive number. */
export function toSmallest(amount: string, decimals: number): string {
  const m = amount.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`not an amount: ${amount}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals: ${amount}`);
  const units = BigInt(m[1]! + frac.padEnd(decimals, "0"));
  if (units === 0n) throw new Error("the amount must be more than zero");
  return units.toString();
}

export interface Answers {
  network: Network;
  owner: string;
  wallet: string;
  perPaymentUsd: number;
  dailyUsd: number;
  receivers: string[];
  newReceiver: "warn" | "block";
  tokens: string[];
  enclave: boolean;
}

/** The owner's few answers become a full policy; everything else keeps SeIn's careful defaults. */
export function policyFrom(a: Answers): Policy {
  const assets = a.tokens.map((s) => {
    const t = tokenOf(a.network, s);
    if (!t) throw new Error(`unknown token ${s}; use ${Object.keys(TOKENS[a.network]).join(", ")}`);
    return t.assetId;
  });
  return Policy.parse({
    ...DEMO_POLICY,
    allowedAssets: [...new Set(assets)],
    // an empty list would fail the schema; the owner's own account is always a safe receiver
    allowedRecipients: [...new Set([...a.receivers, a.owner])],
    unknownRecipient: a.newReceiver,
    minAccountAgeDays: a.network === "testnet" ? 0 : DEMO_POLICY.minAccountAgeDays,
    ownAccounts: [a.wallet, a.owner],
    perTxUsd: a.perPaymentUsd,
    hourlyUsd: a.dailyUsd,
    dailyUsd: a.dailyUsd,
    contracts: {},
    // an enclave objection goes to the owner instead of blocking, so the owner keeps the last word
    tee: { ...DEMO_POLICY.tee, required: a.enclave, obeyBlockSignal: false },
  });
}

/** Sets keys in a .env text, keeping every other line, comment and order. */
export function mergeEnv(text: string, values: Record<string, string>): string {
  const lines = text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : [];
  const left = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !left.has(m[1]!)) return line;
    const v = left.get(m[1]!)!;
    left.delete(m[1]!);
    return `${m[1]}=${v}`;
  });
  for (const [k, v] of left) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

export function readEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export interface AgentAccess { name: string; restUrl: string; token: string; signingKey: string; network: Network; node: string; tsx: string; bridge: string }

/** One MCP server entry, launched with this machine's node so it works the same on Windows, macOS and Linux. */
export function mcpServer(a: AgentAccess) {
  return {
    command: a.node,
    args: [a.tsx, a.bridge],
    env: { SEALED_REST_URL: a.restUrl, SEALED_AGENT_TOKEN: a.token, SEALED_AGENT_SIGNING_KEY: a.signingKey, SEALED_NETWORK: a.network },
  };
}

/** Ready-to-use files for the common agent hosts and for plain HTTP. */
export function agentFiles(a: AgentAccess): Record<string, string> {
  const server = mcpServer(a);
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
  return {
    "mcp.json": json({ mcpServers: { sein: server } }),
    "vscode-mcp.json": json({ servers: { sein: { type: "stdio", ...server } } }),
    "claude-code.txt": `claude mcp add-json sein '${JSON.stringify({ type: "stdio", ...server })}'\n`,
    "agent.env": `SEALED_REST_URL=${a.restUrl}\nSEALED_AGENT_TOKEN=${a.token}\nSEALED_AGENT_SIGNING_KEY=${a.signingKey}\nSEALED_NETWORK=${a.network}\n`,
  };
}
