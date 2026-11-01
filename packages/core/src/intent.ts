import { z } from "zod";

/**
 * What the agent SAYS it wants to do. Everything else (the quote, the route, the
 * deposit address) is fetched and checked by Sealed Intent, never trusted from the agent.
 * The agent's identity is not part of the intent: the server decides who is asking.
 */
const digits = z.string().regex(/^\d+$/, "smallest units, digits only");
const common = {
  /** Business purpose tag. The secret policy can force a confidential route for some purposes. */
  purpose: z.string().default("general"),
  /** Free text from the task or user. Untrusted: scanned for prompt injection. */
  taskText: z.string().max(4000).optional(),
};

export const SwapIntent = z.object({
  kind: z.literal("swap"),
  tokenIn: z.string().min(3).describe("1Click assetId, e.g. nep141:wrap.near"),
  tokenOut: z.string().min(3),
  amountIn: digits,
  recipient: z.string().min(2),
  refundTo: z.string().min(2),
  ...common,
});

export const TransferIntent = z.object({
  kind: z.literal("transfer"),
  token: z.string().min(3).describe("1Click assetId of a NEP-141 token on NEAR"),
  amount: digits,
  recipient: z.string().min(2),
  memo: z.string().max(256).optional(),
  ...common,
});

export const CallIntent = z.object({
  kind: z.literal("call"),
  contract: z.string().min(2),
  method: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  depositYocto: digits.default("0"),
  ...common,
});

/** Classes the policy forbids by default. They are declared so the refusal is explicit and logged. */
export const FORBIDDEN_BY_DEFAULT = ["sign_message", "add_key", "delete_key", "deploy", "delete_account", "stake"] as const;

export const OtherIntent = z.object({
  kind: z.enum(FORBIDDEN_BY_DEFAULT),
  details: z.record(z.unknown()).default({}),
  ...common,
});

export const DeclaredIntent = z.discriminatedUnion("kind", [SwapIntent, TransferIntent, CallIntent, OtherIntent]);
export type DeclaredIntent = z.infer<typeof DeclaredIntent>;
export type SwapIntent = z.infer<typeof SwapIntent>;
export type TransferIntent = z.infer<typeof TransferIntent>;
export type CallIntent = z.infer<typeof CallIntent>;
export type IntentKind = DeclaredIntent["kind"];

export const AgentId = z.string().min(1).max(128);
