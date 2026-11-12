import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

/**
 * The SECRET policy. The agent never sees it: it only receives a verdict and generic
 * reason codes, which raises the cost of probing for the exact limit.
 * At rest the policy is encrypted (AES-256-GCM). Receipts carry a commitment to it.
 */
export const Policy = z.object({
  version: z.literal(1),
  allowedAssets: z.array(z.string()).min(1),
  allowedRecipients: z.array(z.string()).min(1),
  /** recipient not on the allow-list: refuse outright, or ask a human (WARN) */
  unknownRecipient: z.enum(["block", "warn"]),
  /** refuse a receiver whose name imitates a trusted one (address poisoning) */
  lookalikeRecipient: z.enum(["block"]).optional(),
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
  injection: z.object({
    block: z.boolean(),
    /** a request without the task text that led to it cannot be screened: ask a human */
    requireTaskText: z.boolean().default(true),
  }),
  tee: z.object({
    required: z.boolean(),
    /** if the private TEE check says "block", block (true) or only record it (false) */
    obeyBlockSignal: z.boolean(),
    /** Intel TCB statuses the enclave may report */
    acceptedTcbStatuses: z.array(z.string()).default(["UpToDate"]),
    /** refuse models without verified NVIDIA GPU evidence */
    requireGpu: z.boolean().default(true),
    /** accept a response signed by the gateway instead of the model enclave */
    allowGatewaySignature: z.boolean().default(false),
  }),
  /** Action classes the agent may request. Anything in "never" is refused and freezes the wallet. */
  actions: z
    .object({
      allowed: z.array(z.string()).default(["swap", "transfer", "call"]),
      never: z.array(z.string()).default(["sign_message", "add_key", "delete_key", "deploy", "delete_account", "stake"]),
    })
    .prefault({}),
  /** Contracts the agent may call, with the methods and the largest attached deposit (yoctoNEAR). */
  contracts: z.record(z.string(), z.object({ methods: z.array(z.string()).min(1), maxDepositYocto: z.string().regex(/^\d+$/).default("0") })).prefault({}),
  freeze: z
    .object({
      onForbiddenAction: z.boolean().default(true),
      /** this many BLOCKs for one agent within an hour freezes the wallet */
      maxBlocksPerHour: z.number().int().positive().default(20),
      /** BLOCKs caused only by limit codes (an agent probing for the exact cap) freeze sooner, counted over a day */
      maxLimitProbesPerDay: z.number().int().positive().default(3),
    })
    .prefault({}),
  /** Private records (openings, raw enclave exchanges, audit log) are deleted after this many days. */
  retention: z.object({ privateDays: z.number().int().positive().default(30) }).prefault({}),
  /**
   * Extra protection for the per-transaction cap. A fixed cap leaks one bit per probe, so with
   * perTxJitterPct above 0 the effective cap for an agent is redrawn every hour from
   * [cap minus that percent, cap]. Honest payments inside that band can be refused, so it is off by default.
   */
  secrecy: z.object({ perTxJitterPct: z.number().min(0).max(90).default(0) }).prefault({}),
  /** How often the agent may spend, independent of amounts. */
  velocity: z.object({ maxTxPerHour: z.number().int().positive().default(30) }).prefault({}),
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
