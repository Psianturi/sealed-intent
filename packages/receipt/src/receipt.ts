import { randomUUID } from "node:crypto";
import { canonicalJson } from "./canonical";
import { commit, openingMatches, type Opening } from "./commit";
import { signBytes, verifyBytes, type IssuerKey } from "./keys";
import { verifyTeeEvidence, type TeeCheckResult, type TeeEvidence } from "./tee";

/** ALLOW: execute. WARN: a human must approve first. BLOCK: refuse. */
export type Verdict = "ALLOW" | "WARN" | "BLOCK";

/** Fields that stay private by default. Each one is published only as a salted commitment. */
export const PRIVATE_FIELDS = [
  "agentId",
  "tokenIn",
  "tokenOut",
  "amountIn",
  "minAmountOut",
  "recipient",
  "refundTo",
  "depositAddress",
  "taskText",
  "contract",
  "method",
  "args",
  "details",
] as const;
export type PrivateField = (typeof PRIVATE_FIELDS)[number];

export interface Receipt {
  version: "sealed-intent/receipt@1";
  receiptId: string;
  issuedAt: string;
  verdict: Verdict;
  /** Generic codes only. Thresholds from the secret policy are never included. */
  reasonCodes: string[];
  /** Codes that caused a WARN (human review) rather than a BLOCK. */
  warnCodes?: string[];
  public: {
    intentKind: string;
    route: "public" | "confidential-basic" | "confidential-advanced";
    mode: "live" | "offline";
    quote?: {
      correlationId?: string;
      signatureVerified: boolean;
      dry: boolean;
    };
    budgetReservationId?: string;
    executionTx?: string;
  };
  /** commitment = sha256(salt:canonical(value)) for each private field */
  commitments: Partial<Record<PrivateField, string>>;
  /** commitment to the exact secret policy that was applied */
  policyCommitment: string;
  tee?: TeeEvidence;
  issuer: { alg: "ed25519"; publicKey: string };
  signature: string;
}

/** Kept by the operator, never published. Used to disclose single fields later. */
export interface PrivateOpenings {
  receiptId: string;
  openings: Partial<Record<PrivateField, Opening>>;
  policyOpening: Opening;
}

export interface Disclosure {
  receiptId: string;
  field: PrivateField | "policy";
  opening: Opening;
}

export interface BuildReceiptInput {
  verdict: Verdict;
  reasonCodes: string[];
  warnCodes?: string[];
  publicPart: Receipt["public"];
  privateValues: Partial<Record<PrivateField, unknown>>;
  policy: unknown;
  tee?: TeeEvidence;
}

function signedPayload(r: Omit<Receipt, "signature">): string {
  return canonicalJson(r);
}

export function buildReceipt(input: BuildReceiptInput, issuer: IssuerKey): { receipt: Receipt; openings: PrivateOpenings } {
  const receiptId = randomUUID();
  const commitments: Receipt["commitments"] = {};
  const openings: PrivateOpenings["openings"] = {};
  for (const field of PRIVATE_FIELDS) {
    const value = input.privateValues[field];
    if (value === undefined) continue;
    const c = commit(value);
    commitments[field] = c.commitment;
    openings[field] = c.opening;
  }
  const policy = commit(input.policy);
  const unsigned: Omit<Receipt, "signature"> = {
    version: "sealed-intent/receipt@1",
    receiptId,
    issuedAt: new Date().toISOString(),
    verdict: input.verdict,
    reasonCodes: [...input.reasonCodes].sort(),
    warnCodes: input.warnCodes?.length ? [...input.warnCodes].sort() : undefined,
    public: input.publicPart,
    commitments,
    policyCommitment: policy.commitment,
    tee: input.tee,
    issuer: { alg: "ed25519", publicKey: issuer.publicKeyHex },
  };
  const receipt: Receipt = { ...unsigned, signature: signBytes(issuer, signedPayload(unsigned)) };
  return { receipt, openings: { receiptId, openings, policyOpening: policy.opening } };
}

export function makeDisclosure(openings: PrivateOpenings, field: PrivateField | "policy"): Disclosure {
  const opening = field === "policy" ? openings.policyOpening : openings.openings[field];
  if (!opening) throw new Error(`no private value recorded for field "${field}"`);
  return { receiptId: openings.receiptId, field, opening };
}

export interface VerifyReport {
  valid: boolean;
  issuerSignatureValid: boolean;
  trustedIssuer: boolean | "not-checked";
  tee?: TeeCheckResult;
  disclosures: { field: string; matches: boolean; value?: unknown }[];
  problems: string[];
}

/**
 * Verify a receipt without talking to any server:
 *  1. ed25519 issuer signature over the canonical receipt
 *  2. optional: issuer key equals a key you trust
 *  3. TEE evidence: signed text == hashes, signature recovers to signing address
 *  4. optional disclosures: each opening matches its commitment
 */
export function verifyReceipt(
  receipt: Receipt,
  opts: { disclosures?: Disclosure[]; trustedIssuerKeys?: string[] } = {},
): VerifyReport {
  const problems: string[] = [];
  const { signature, ...unsigned } = receipt;
  const issuerSignatureValid = verifyBytes(receipt.issuer.publicKey, signedPayload(unsigned), signature);
  if (!issuerSignatureValid) problems.push("issuer signature invalid (receipt was modified or forged)");

  let trustedIssuer: VerifyReport["trustedIssuer"] = "not-checked";
  if (opts.trustedIssuerKeys?.length) {
    trustedIssuer = opts.trustedIssuerKeys.includes(receipt.issuer.publicKey);
    if (!trustedIssuer) problems.push("issuer key is not in the trusted list");
  }

  let tee: TeeCheckResult | undefined;
  if (receipt.tee) {
    tee = verifyTeeEvidence(receipt.tee);
    if (!tee.signatureValid || !tee.textMatchesHashes) problems.push(...tee.problems.filter((p) => !p.startsWith("simulated")));
  }

  const disclosures = (opts.disclosures ?? []).map((d) => {
    if (d.receiptId !== receipt.receiptId) {
      problems.push(`disclosure for ${d.field} belongs to another receipt`);
      return { field: d.field, matches: false };
    }
    const commitment = d.field === "policy" ? receipt.policyCommitment : receipt.commitments[d.field];
    const matches = !!commitment && openingMatches(commitment, d.opening);
    if (!matches) problems.push(`disclosed value for ${d.field} does not match its commitment`);
    return { field: d.field, matches, value: matches ? d.opening.value : undefined };
  });

  const valid = issuerSignatureValid && trustedIssuer !== false && (!tee || (tee.signatureValid && tee.textMatchesHashes)) && disclosures.every((d) => d.matches);
  return { valid, issuerSignatureValid, trustedIssuer, tee, disclosures, problems };
}
