import type { CallIntent, SwapIntent, TransferIntent } from "./intent";
import type { QuoteResponse, TokenResponse } from "./oneclick";
import type { Policy } from "./policy";
import type { QuoteSignatureStatus } from "./quote-signature";

/**
 * Deterministic checks of a 1Click quote against what the agent declared and what
 * the secret policy allows. These decide the verdict. No LLM is involved here.
 */
export interface QuoteCheckInput {
  intent: SwapIntent;
  policy: Policy;
  tokens: TokenResponse[];
  quote: QuoteResponse;
  signature: QuoteSignatureStatus;
  expectDepositAddress: boolean;
  now?: number;
}

export interface QuoteMetrics {
  inUsd: number;
  minOutUsd: number;
  lossBps: number;
}

export interface QuoteCheckResult {
  block: string[];
  warn: string[];
  metrics?: QuoteMetrics;
}

export function units(amount: string, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export function findToken(tokens: TokenResponse[], assetId: string): TokenResponse | undefined {
  const found = tokens.find((t) => t.assetId === assetId);
  if (found || assetId !== "native") return found;
  // 1Click lists wNEAR, not native NEAR; one NEAR is worth one wNEAR and both have 24 decimals
  const wnear = tokens.find((t) => t.assetId === "nep141:wrap.near");
  return wnear && { ...wnear, assetId: "native", symbol: "NEAR" };
}

export function checkQuote(input: QuoteCheckInput): QuoteCheckResult {
  const { intent, policy, tokens, quote, signature } = input;
  const now = input.now ?? Date.now();
  const block: string[] = [];
  const warn: string[] = [];
  const req = quote.quoteRequest;
  const q = quote.quote;

  // 1. the quote must be the one 1Click signed
  if (signature === "invalid") block.push("QUOTE_SIGNATURE_INVALID");
  if (signature === "unavailable") (policy.requireQuoteSignature ? block : warn).push("QUOTE_SIGNATURE_UNVERIFIED");

  // 2. the quote must describe exactly what the agent declared
  if (req.originAsset !== intent.tokenIn || req.destinationAsset !== intent.tokenOut) block.push("QUOTE_ASSET_MISMATCH");
  if (q.amountIn !== intent.amountIn || req.amount !== intent.amountIn) block.push("QUOTE_AMOUNT_MISMATCH");
  if (req.recipient !== intent.recipient) block.push("QUOTE_RECIPIENT_MISMATCH");
  if (req.refundTo !== intent.refundTo) block.push("QUOTE_REFUND_MISMATCH");

  // 3. the assets themselves: allowed, known, and not a look-alike of an allowed one
  for (const assetId of [intent.tokenIn, intent.tokenOut]) {
    const code = assetCode(assetId, policy, tokens);
    if (code) block.push(code);
  }

  // 4. refunds must come back to the owner (the recipient is judged by the counterparty check)
  if (!policy.ownAccounts.includes(intent.refundTo)) block.push("REFUND_NOT_OWN_ACCOUNT");

  // 5. timing
  const deadline = Date.parse(q.deadline ?? req.deadline);
  if (Number.isFinite(deadline) && deadline - now > policy.maxDeadlineSec * 1000) block.push("DEADLINE_TOO_FAR");

  // 6. live quote must name where the funds go
  if (input.expectDepositAddress && !q.depositAddress) block.push("MISSING_DEPOSIT_ADDRESS");

  // 7. route must match the privacy policy
  const wantsPrivate = policy.privatePurposes.includes(intent.purpose);
  const route = req.confidentiality ?? "public";
  if (wantsPrivate && route === "public") block.push("ROUTE_NOT_CONFIDENTIAL");

  // 8. value: priced with 1Click's token list rather than the quote's own USD fields (same provider; a second source is on the roadmap)
  const tIn = findToken(tokens, intent.tokenIn);
  const tOut = findToken(tokens, intent.tokenOut);
  let metrics: QuoteMetrics | undefined;
  if (!tIn || !tOut || !(tIn.price > 0) || !(tOut.price > 0)) {
    block.push("NO_REFERENCE_PRICE");
  } else {
    const inUsd = units(intent.amountIn, tIn.decimals) * tIn.price;
    const minOutUsd = units(q.minAmountOut, tOut.decimals) * tOut.price;
    const lossBps = inUsd > 0 ? Math.round((1 - minOutUsd / inUsd) * 10_000) : 10_000;
    metrics = { inUsd, minOutUsd, lossBps };
    if (lossBps > policy.maxLossBps) block.push("EXCESSIVE_VALUE_LOSS");
    if (inUsd > policy.perTxUsd) block.push("ABOVE_PER_TX_LIMIT");
    const quotedInUsd = Number(q.amountInUsd);
    if (Number.isFinite(quotedInUsd) && quotedInUsd > 0 && Math.abs(quotedInUsd - inUsd) / inUsd > 0.05) {
      warn.push("QUOTE_USD_DIVERGES_FROM_REFERENCE");
    }
  }

  return { block: [...new Set(block)], warn: [...new Set(warn)], metrics };
}

/** Allowed, known, and not a look-alike of an allowed asset. Returns the block code or null. */
export function assetCode(assetId: string, policy: Policy, tokens: TokenResponse[]): string | null {
  if (policy.allowedAssets.includes(assetId)) return null;
  const token = findToken(tokens, assetId);
  const lookalike =
    token &&
    policy.allowedAssets.some((allowedId) => {
      const allowed = findToken(tokens, allowedId);
      return allowed && allowed.symbol.toUpperCase() === token.symbol.toUpperCase();
    });
  return lookalike ? "LOOKALIKE_ASSET" : token ? "ASSET_NOT_ALLOWED" : "UNKNOWN_ASSET";
}

/** A plain NEP-141 transfer: asset, per-transaction cap, reference price. */
export function checkTransfer(input: { intent: TransferIntent; policy: Policy; tokens: TokenResponse[] }): QuoteCheckResult {
  const { intent, policy, tokens } = input;
  const block: string[] = [];
  const code = assetCode(intent.token, policy, tokens);
  if (code) block.push(code);
  const t = findToken(tokens, intent.token);
  let metrics: QuoteMetrics | undefined;
  if (!t || !(t.price > 0)) block.push("NO_REFERENCE_PRICE");
  else {
    const inUsd = units(intent.amount, t.decimals) * t.price;
    metrics = { inUsd, minOutUsd: inUsd, lossBps: 0 };
    if (inUsd > policy.perTxUsd) block.push("ABOVE_PER_TX_LIMIT");
  }
  return { block: [...new Set(block)], warn: [], metrics };
}

/** A contract call: the contract and method must be allow-listed, and the deposit capped. */
export function checkCall(input: { intent: CallIntent; policy: Policy; tokens: TokenResponse[] }): QuoteCheckResult {
  const { intent, policy, tokens } = input;
  const block: string[] = [];
  const rule = policy.contracts[intent.contract];
  if (!rule) block.push("CONTRACT_NOT_ALLOWED");
  else if (!rule.methods.includes(intent.method)) block.push("METHOD_NOT_ALLOWED");
  else if (BigInt(intent.depositYocto) > BigInt(rule.maxDepositYocto)) block.push("DEPOSIT_TOO_LARGE");
  let metrics: QuoteMetrics = { inUsd: 0, minOutUsd: 0, lossBps: 0 };
  if (BigInt(intent.depositYocto) > 0n) {
    const near = findToken(tokens, "nep141:wrap.near");
    if (!near || !(near.price > 0)) block.push("NO_REFERENCE_PRICE");
    else {
      const inUsd = units(intent.depositYocto, 24) * near.price;
      metrics = { inUsd, minOutUsd: inUsd, lossBps: 0 };
      if (inUsd > policy.perTxUsd) block.push("ABOVE_PER_TX_LIMIT");
    }
  }
  return { block: [...new Set(block)], warn: [], metrics };
}

/** Compare the dry quote with the live quote that carries the deposit address. */
export function checkDryLiveDrift(dry: QuoteResponse, live: QuoteResponse, policy: Policy): string[] {
  const out: string[] = [];
  const dryMin = Number(dry.quote.minAmountOut);
  const liveMin = Number(live.quote.minAmountOut);
  if (dryMin > 0 && ((dryMin - liveMin) / dryMin) * 10_000 > policy.maxDryLiveDriftBps) out.push("DRY_LIVE_DRIFT");
  const same = (k: keyof QuoteResponse["quoteRequest"]) => dry.quoteRequest[k] === live.quoteRequest[k];
  if (!same("originAsset") || !same("destinationAsset") || !same("recipient") || !same("refundTo") || !same("amount")) {
    out.push("DRY_LIVE_REQUEST_CHANGED");
  }
  return out;
}
