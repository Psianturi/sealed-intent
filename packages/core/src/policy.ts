import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

/**
 * The SECRET policy. The agent never sees it: it only receives a verdict and generic
 * reason codes, so it cannot probe for the exact limit and stay just under it.
 * At rest the policy is encrypted (AES-256-GCM). Receipts carry a commitment to it.
 */
export const Policy = z.object({
  version: z.literal(1),
  allowedAssets: z.array(z.string()).min(1),
  allowedRecipients: z.array(z.string()).min(1),
  /** recipient not on the allow-list: refuse outright, or ask a human (WARN) */
  unknownRecipient: z.enum(["block", "warn"]),
  /** younger counterparties are flagged for human review */
  minAccountAgeDays: z.number().int().min(0),
  ownAccounts: z.array(z.string()).min(1),
  /** max value lost between amountIn (USD at reference price) and minAmountOut (USD) */
  maxLossBps: z.number().int().min(0).max(10_000),
  perTxUsd: z.number().positive(),
  hourlyUsd: z.number().positive(),
  dailyUsd: z.number().positive(),
  maxDeadlineSec: z.number().int().positive(),
  slippageToleranceBps: z.number().int().min(0).max(5_000),
  requireQuoteSignature: z.boolean(),
  maxDryLiveDriftBps: z.number().int().min(0),
  /** purposes that must use a confidential route */
  privatePurposes: z.array(z.string()),
  confidentialLevel: z.enum(["basic", "advanced"]),
  injection: z.object({ block: z.boolean() }),
  tee: z.object({
    required: z.boolean(),
    /** if the private TEE check says "block", block (true) or only record it (false) */
    obeyBlockSignal: z.boolean(),
  }),
  /** Action classes the agent may request. Anything in "never" is refused and freezes the wallet. */
  actions: z
    .object({
      allowed: z.array(z.string()).default(["swap", "transfer", "call"]),
      never: z.array(z.string()).default(["sign_message", "add_key", "delete_key", "deploy", "delete_account", "stake"]),
    })
    .default({}),
  /** Contracts the agent may call, with the methods and the largest attached deposit (yoctoNEAR). */
  contracts: z.record(z.object({ methods: z.array(z.string()).min(1), maxDepositYocto: z.string().regex(/^\d+$/).default("0") })).default({}),
  freeze: z
    .object({
      onForbiddenAction: z.boolean().default(true),
      /** this many BLOCKs for one agent within an hour freezes the wallet */
      maxBlocksPerHour: z.number().int().positive().default(20),
    })
    .default({}),
});
export type Policy = z.infer<typeof Policy>;

const ALG = "aes-256-gcm";

export interface SealedPolicyFile {
  alg: typeof ALG;
  iv: string;
  tag: string;
  ciphertext: string;
}

function keyFrom(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("SEALED_POLICY_KEY must be 32 bytes hex (openssl rand -hex 32)");
  return key;
}

export function sealPolicy(policy: Policy, keyHex: string): SealedPolicyFile {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, keyFrom(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(Policy.parse(policy)), "utf8"), cipher.final()]);
  return { alg: ALG, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") };
}

export function unsealPolicy(file: SealedPolicyFile, keyHex: string): Policy {
  const decipher = createDecipheriv(ALG, keyFrom(keyHex), Buffer.from(file.iv, "hex"));
  decipher.setAuthTag(Buffer.from(file.tag, "hex"));
  const plain = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, "hex")), decipher.final()]).toString("utf8");
  return Policy.parse(JSON.parse(plain));
}

export function writeSealedPolicy(path: string, policy: Policy, keyHex: string): void {
  writeFileSync(path, JSON.stringify(sealPolicy(policy, keyHex), null, 2), { mode: 0o600 });
}

export function readSealedPolicy(path: string, keyHex: string): Policy {
  return unsealPolicy(JSON.parse(readFileSync(path, "utf8")) as SealedPolicyFile, keyHex);
}
