import { createHash } from "node:crypto";
import { canonicalJson } from "@sealed-intent/receipt";
import type { OwnerReview } from "./preflight";

/**
 * The owner approves with a wallet signature instead of a shared token. The signed message names
 * the decision and a hash of exactly what the owner was shown, so a signature cannot be moved to
 * another payment and a server cannot show one thing and execute another.
 */
export const APPROVAL_RECIPIENT = "sein-approval";

export interface SignedApproval {
  action: "approve" | "reject";
  decisionId: string;
  accountId: string;
  publicKey: string;
  signature: string;
  /** base64 of the 32-byte NEP-413 nonce */
  nonce: string;
}

export const reviewHash = (review: OwnerReview): string => {
  const { approvedBy: _a, ...shown } = review;
  return createHash("sha256").update(canonicalJson(shown), "utf8").digest("hex");
};

export const approvalMessage = (action: SignedApproval["action"], decisionId: string, hash: string) => `SeIn ${action} ${decisionId} ${hash}`;

/** Confirms the key is a full-access key of the account on chain. */
export interface ApprovalVerifier {
  verify(a: SignedApproval, message: string): Promise<boolean>;
}

export class ChainApprovalVerifier implements ApprovalVerifier {
  constructor(private readonly networkId: string, private readonly rpcUrl: string) {}

  async verify(a: SignedApproval, message: string): Promise<boolean> {
    const { Near, verifyNep413Signature } = await import("near-kit");
    const near = new Near({ network: { networkId: this.networkId, rpcUrl: this.rpcUrl } });
    return verifyNep413Signature({ accountId: a.accountId, publicKey: a.publicKey, signature: a.signature }, { message, recipient: APPROVAL_RECIPIENT, nonce: Buffer.from(a.nonce, "base64") }, { near });
  }
}

export async function checkApproval(a: SignedApproval, expected: { owner: string; review: OwnerReview | undefined }, verifier: ApprovalVerifier): Promise<{ ok: boolean; reason?: string }> {
  if (!expected.review) return { ok: false, reason: "unknown, blocked or already executed decision" };
  if (a.accountId !== expected.owner) return { ok: false, reason: "not the owner of this wallet" };
  const message = approvalMessage(a.action, a.decisionId, reviewHash(expected.review));
  try {
    return (await verifier.verify(a, message)) ? { ok: true } : { ok: false, reason: "signature does not match this decision" };
  } catch {
    return { ok: false, reason: "signature could not be checked" };
  }
}
