import { z } from "zod";

/**
 * What the agent SAYS it wants to do. Everything else (the quote, the route, the
 * deposit address) is fetched and checked by Sealed Intent, never trusted from the agent.
 */
export const DeclaredIntent = z.object({
  agentId: z.string().min(1),
  kind: z.literal("swap"),
  tokenIn: z.string().min(3).describe("1Click assetId, e.g. nep141:wrap.near"),
  tokenOut: z.string().min(3),
  amountIn: z.string().regex(/^\d+$/, "smallest units, digits only"),
  recipient: z.string().min(2),
  refundTo: z.string().min(2),
  /** Business purpose tag. The secret policy can force a confidential route for some purposes. */
  purpose: z.string().default("general"),
  /** Free text from the task or user. Untrusted: scanned for prompt injection. */
  taskText: z.string().max(4000).optional(),
});
export type DeclaredIntent = z.infer<typeof DeclaredIntent>;
