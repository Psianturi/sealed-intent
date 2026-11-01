import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { base58Encode } from "./base58";
import type { BlocklistEntry, ChainAccountInfo } from "./counterparty";
import type { OneClickClient, QuoteRequest, QuoteResponse, TokenResponse } from "./oneclick";
import type { Policy } from "./policy";
import { quoteHashOf } from "./quote-signature";

/**
 * OFFLINE FIXTURES. Shapes follow the 1Click OpenAPI spec; prices are a snapshot
 * (late Oct 2026, approximate) so judges can run everything without keys or funds.
 */
export const ASSET = {
  wNEAR: "nep141:wrap.near",
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  USDT: "nep141:usdt.tether-token.near",
  /** look-alike: also called "USDC", but a different contract */
  FAKE_USDC: "nep141:usdc-official.near",
} as const;

export const FIXTURE_TOKENS: TokenResponse[] = [
  { assetId: ASSET.wNEAR, decimals: 24, blockchain: "near", symbol: "wNEAR", price: 4.45, priceUpdatedAt: "2026-10-30T00:00:00.000Z", contractAddress: "wrap.near" },
  { assetId: ASSET.USDC, decimals: 6, blockchain: "near", symbol: "USDC", price: 1.0, priceUpdatedAt: "2026-10-30T00:00:00.000Z", contractAddress: ASSET.USDC.slice(7) },
  { assetId: ASSET.USDT, decimals: 6, blockchain: "near", symbol: "USDT", price: 1.0, priceUpdatedAt: "2026-10-30T00:00:00.000Z", contractAddress: "usdt.tether-token.near" },
  { assetId: ASSET.FAKE_USDC, decimals: 6, blockchain: "near", symbol: "USDC", price: 1.0, priceUpdatedAt: "2026-10-30T00:00:00.000Z", contractAddress: "usdc-official.near" },
];

export const DEMO_ACCOUNTS = {
  self: "sealed-demo.near",
  payroll: "payroll-alice.near",
  /** on the shared blocklist, with evidence */
  attacker: "drainer-9f3a.near",
  /** real-looking but 3 days old and never paid before */
  newVendor: "fresh-vendor-2026.near",
  /** a contract whose code changed since we last saw it */
  upgradedContract: "vault-upgraded.near",
  /** does not exist on chain */
  ghost: "typo-paymnts.near",
  /** a contract the agent may call, but only its allow-listed methods */
  pool: "payout-pool.near",
};

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

/** Offline stand-in for NEAR RPC + an indexer (account age). */
export const FIXTURE_CHAIN: Record<string, ChainAccountInfo> = {
  [DEMO_ACCOUNTS.self]: { exists: true, isContract: false, createdAt: daysAgo(420) },
  [DEMO_ACCOUNTS.payroll]: { exists: true, isContract: false, createdAt: daysAgo(210) },
  [DEMO_ACCOUNTS.attacker]: { exists: true, isContract: false, createdAt: daysAgo(2) },
  [DEMO_ACCOUNTS.newVendor]: { exists: true, isContract: false, createdAt: daysAgo(3) },
  [DEMO_ACCOUNTS.upgradedContract]: { exists: true, isContract: true, codeHash: "9xNewCodeHashAfterUpgrade1111111111111111111", createdAt: daysAgo(300) },
  [DEMO_ACCOUNTS.pool]: { exists: true, isContract: true, codeHash: "7pPoolCodeHash111111111111111111111111111111", createdAt: daysAgo(200) },
};
/** what we "saw" for vault-upgraded.near before (seeded into memory offline) */
export const FIXTURE_PREVIOUS_CODE_HASH: Record<string, string> = {
  [DEMO_ACCOUNTS.upgradedContract]: "4fOldAuditedCodeHash11111111111111111111111",
};

export const FIXTURE_BLOCKLIST: BlocklistEntry[] = [
  {
    account: DEMO_ACCOUNTS.attacker,
    reason: "received funds from 3 prompt-injected agents within 24h (FIXTURE: illustrative, not a real account)",
    evidence: ["receipt:fixture-7c1e", "tx:FIXTURE9bPq...e21", "report:ops-bot-7"],
    reportedBy: "ops-bot-7",
    confirmed: true,
    reportedAt: "2026-10-29T08:00:00.000Z",
  },
];

export const DEMO_POLICY: Policy = {
  version: 1,
  allowedAssets: [ASSET.wNEAR, ASSET.USDC, ASSET.USDT],
  allowedRecipients: [DEMO_ACCOUNTS.self, DEMO_ACCOUNTS.payroll, DEMO_ACCOUNTS.pool],
  unknownRecipient: "warn",
  minAccountAgeDays: 30,
  ownAccounts: [DEMO_ACCOUNTS.self],
  maxLossBps: 300,
  perTxUsd: 50,
  hourlyUsd: 100,
  dailyUsd: 100,
  maxDeadlineSec: 900,
  slippageToleranceBps: 100,
  requireQuoteSignature: true,
  maxDryLiveDriftBps: 150,
  privatePurposes: ["payroll"],
  confidentialLevel: "basic",
  injection: { block: true, requireTaskText: true },
  tee: { required: false, obeyBlockSignal: true, acceptedTcbStatuses: ["UpToDate"], requireGpu: true, allowGatewaySignature: false },
  actions: { allowed: ["swap", "transfer", "call"], never: ["sign_message", "add_key", "delete_key", "deploy", "delete_account", "stake"] },
  contracts: { [DEMO_ACCOUNTS.pool]: { methods: ["deposit", "claim"], maxDepositYocto: "1000000000000000000000000" } },
  freeze: { onForbiddenAction: true, maxBlocksPerHour: 20, maxLimitProbesPerHour: 6 },
  velocity: { maxTxPerHour: 30 },
};

// Deterministic ed25519 "1Click manager" key for offline quotes.
const SEED = createHash("sha256").update("sealed-intent offline 1click manager key").digest();
const MANAGER_PRIV = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), SEED]), format: "der", type: "pkcs8" });
const MANAGER_PUB_RAW = createPublicKey(MANAGER_PRIV).export({ type: "spki", format: "der" }).subarray(-32);
export const FIXTURE_MANAGER_PUBLIC_KEY = `ed25519:${base58Encode(MANAGER_PUB_RAW)}`;

export async function signFixtureQuote(response: Omit<QuoteResponse, "signature"> & { signature?: string }): Promise<QuoteResponse> {
  const unsigned = { ...response, signature: "" } as QuoteResponse;
  const hash = await quoteHashOf(unsigned);
  if (!hash) throw new Error("1Click SDK not installed: cannot sign fixture quotes");
  const sig = sign(null, Buffer.from(new TextEncoder().encode(hash)), MANAGER_PRIV);
  return { ...unsigned, signature: `ed25519:${base58Encode(sig)}` };
}

/** Knobs the red team uses to make the "market" misbehave. */
export interface FixtureBehavior {
  /** shave this much off minAmountOut (a route through a thin or rigged pool) */
  minOutHaircutBps?: number;
  /** extra haircut only on the live (non-dry) quote: quote changed between check and execution */
  liveHaircutBps?: number;
  /** override the quoted recipient (a compromised quoting tool) */
  recipientOverride?: string;
}

export class FixtureOneClickClient implements OneClickClient {
  readonly mode = "offline" as const;
  behavior: FixtureBehavior = {};

  constructor(private readonly tokens: TokenResponse[] = FIXTURE_TOKENS, private readonly feeBps = 20) {}

  async getTokens(): Promise<TokenResponse[]> {
    return this.tokens;
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    const tIn = this.tokens.find((t) => t.assetId === req.originAsset);
    const tOut = this.tokens.find((t) => t.assetId === req.destinationAsset);
    if (!tIn || !tOut) throw new Error(`1Click fixture: unsupported asset ${!tIn ? req.originAsset : req.destinationAsset}`);
    const inUnits = Number(req.amount) / 10 ** tIn.decimals;
    const inUsd = inUnits * tIn.price;
    const outUnits = (inUsd * (1 - this.feeBps / 10_000)) / tOut.price;
    const haircutBps = (this.behavior.minOutHaircutBps ?? 0) + (req.dry ? 0 : this.behavior.liveHaircutBps ?? 0);
    const minOutUnits = outUnits * (1 - req.slippageTolerance / 10_000) * (1 - haircutBps / 10_000);
    const toSmallest = (u: number, d: number) => BigInt(Math.floor(u * 10 ** Math.min(d, 15))) * 10n ** BigInt(Math.max(0, d - 15));
    const amountOut = toSmallest(outUnits, tOut.decimals).toString();
    const minAmountOut = toSmallest(minOutUnits, tOut.decimals).toString();
    const quoteRequest: QuoteRequest = { ...req, recipient: this.behavior.recipientOverride ?? req.recipient };
    return signFixtureQuote({
      correlationId: randomBytes(16).toString("hex"),
      timestamp: new Date().toISOString(),
      quoteRequest,
      quote: {
        ...(req.dry ? {} : { depositAddress: randomBytes(32).toString("hex") }),
        amountIn: req.amount,
        amountInFormatted: inUnits.toString(),
        amountInUsd: inUsd.toFixed(4),
        minAmountIn: req.amount,
        amountOut,
        amountOutFormatted: outUnits.toString(),
        amountOutUsd: (outUnits * tOut.price).toFixed(4),
        minAmountOut,
        deadline: req.deadline,
        timeEstimate: 20,
      },
    });
  }

  async submitDeposit(): Promise<unknown> {
    return { ok: true };
  }
}
