// Checks for the proof page that need no network: NEAR Intents quote signatures and NEP-413 wallet signatures.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { canonical } from "./verify-core";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  for (; n > 0n; n /= 256n) out.unshift(Number(n % 256n));
  for (const c of s) {
    if (c !== "1") break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let s = "";
  for (; n > 0n; n /= 58n) s = ALPHABET[Number(n % 58n)] + s;
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const keyBytes = (k: string) => base58Decode(k.replace(/^ed25519:/, ""));

/** Sorted keys, members that are undefined left out: what json-stable-stringify gives the 1Click SDK. */
export function stableJson(v: unknown): string | undefined {
  if (v === undefined || typeof v === "function") return undefined;
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x) ?? "null").join(",")}]`;
  const o = v as Record<string, unknown>;
  const parts = Object.keys(o)
    .sort()
    .flatMap((k) => {
      const s = stableJson(o[k]);
      return s === undefined ? [] : [`${JSON.stringify(k)}:${s}`];
    });
  return `{${parts.join(",")}}`;
}

/** The key 1Click signs quotes with, as published in its official SDK. */
export const ONE_CLICK_MANAGER_KEY = "ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc";

export interface QuoteResponse { quoteRequest: Record<string, any>; quote: Record<string, any>; signature: string; timestamp: string }

// the fields the signature covers, in the shape the official SDK builds them
function signedRequest(r: Record<string, any>) {
  const or = (x: unknown) => (x ? x : undefined);
  return {
    dry: r.dry, swapType: r.swapType, slippageTolerance: r.slippageTolerance, originAsset: r.originAsset, depositType: r.depositType,
    destinationAsset: r.destinationAsset, amount: r.amount, refundTo: r.refundTo, refundType: r.refundType, recipient: r.recipient,
    recipientType: r.recipientType, deadline: r.deadline, quoteWaitingTimeMs: or(r.quoteWaitingTimeMs), referral: or(r.referral),
    virtualChainRecipient: or(r.virtualChainRecipient), virtualChainRefundRecipient: or(r.virtualChainRefundRecipient), customRecipientMsg: or(r.customRecipientMsg),
  };
}

function signedQuote(q: Record<string, any>, dry: boolean) {
  const base = { amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd, minAmountIn: q.minAmountIn, amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut };
  if (dry) return base;
  const or = (x: unknown) => x || undefined;
  return { ...base, depositAddress: or(q.depositAddress), depositMemo: or(q.depositMemo), deadline: or(q.deadline), timeWhenInactive: or(q.timeWhenInactive), timeEstimate: or(q.timeEstimate), refundFee: or(q.refundFee), withdrawFee: or(q.withdrawFee) };
}

export function quoteHash(r: QuoteResponse): string {
  const data = stableJson({ ...signedRequest(r.quoteRequest), ...signedQuote(r.quote, !!r.quoteRequest.dry), timestamp: r.timestamp })!;
  return base58Encode(sha256(utf8ToBytes(data)));
}

export function verifyQuote(r: QuoteResponse, managerKey = ONE_CLICK_MANAGER_KEY): boolean {
  try {
    return ed25519.verify(keyBytes(r.signature), utf8ToBytes(quoteHash(r)), keyBytes(managerKey));
  } catch {
    return false;
  }
}

export const NEP413_TAG = 2147484061;
const u32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const borshString = (s: string) => {
  const b = utf8ToBytes(s);
  return [...u32(b.length), ...b];
};

/** What a NEAR wallet signs for NEP-413: sha256 of the tag and the borsh payload. */
export function nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }): Uint8Array {
  const callback = p.callbackUrl ? [1, ...borshString(p.callbackUrl)] : [0];
  return sha256(Uint8Array.from([...u32(NEP413_TAG), ...borshString(p.message), ...p.nonce, ...borshString(p.recipient), ...callback]));
}

export interface SignedMessage { accountId: string; publicKey: string; signature: string; nonce: string }

export function verifyNep413(s: SignedMessage, message: string, recipient: string): boolean {
  try {
    const nonce = fromBase64(s.nonce);
    if (nonce.length !== 32) return false;
    return ed25519.verify(fromBase64(s.signature), nep413Hash({ message, nonce, recipient }), keyBytes(s.publicKey));
  } catch {
    return false;
  }
}

/** near-kit puts the signing time in the first 8 bytes of the nonce. */
export const nonceTime = (nonce: string) => Number(new DataView(fromBase64(nonce).buffer).getBigUint64(0, false));

/** The hash of what the owner was shown, as SeIn puts it in the approval message. */
export function reviewHashOf(review: Record<string, unknown>): string {
  const { approvedBy: _a, ...shown } = review;
  return bytesToHex(sha256(utf8ToBytes(canonical(shown))));
}
