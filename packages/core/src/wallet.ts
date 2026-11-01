import type { DeclaredIntent } from "./intent";
import type { Decision, Preflight } from "./preflight";
import type { ExecutionResult } from "./executor";
import type { QuoteResponse } from "./oneclick";

/**
 * Agent-side wrapper. This is the ONLY way the agent can spend:
 *   BLOCK -> refuse to sign
 *   WARN  -> ask a human; sign only if they approve
 *   ALLOW -> sign (through the custody enclave)
 */
export interface HumanApprover {
  /** return the approver's name to approve, or null to reject */
  review(decision: Decision, intent: DeclaredIntent): Promise<string | null>;
}

export type WalletOutcome =
  | { outcome: "executed"; decision: Decision; execution: ExecutionResult }
  | { outcome: "refused"; decision: Decision }
  | { outcome: "rejected-by-human"; decision: Decision }
  | { outcome: "failed"; decision: Decision; execution: ExecutionResult };

export class SealedWallet {
  constructor(
    private readonly preflight: Preflight,
    private readonly human: HumanApprover,
    private readonly log: (line: string) => void = () => {},
  ) {}

  async swap(intent: DeclaredIntent, agentQuote?: QuoteResponse): Promise<WalletOutcome> {
    this.log(`[agent ${intent.agentId}] wants to swap ${intent.amountIn} ${short(intent.tokenIn)} -> ${short(intent.tokenOut)} for ${intent.recipient}`);
    const decision = await this.preflight.evaluate({ intent, agentQuote });
    const why = [...decision.reasonCodes, ...decision.warnCodes].join(", ") || "all checks passed";
    this.log(`[sealed-intent] ${decision.verdict}  (${why})  receipt ${decision.decisionId.slice(0, 8)}`);

    if (decision.verdict === "BLOCK") {
      this.log(`[wallet] refusing to sign. Nothing left the wallet.`);
      return { outcome: "refused", decision };
    }
    if (decision.verdict === "WARN") {
      this.log(`[wallet] needs a human: asking for approval...`);
      const approver = await this.human.review(decision, intent);
      if (!approver) {
        this.preflight.reject(decision.decisionId, "human");
        this.log(`[human] rejected. Budget released, nothing signed.`);
        return { outcome: "rejected-by-human", decision };
      }
      this.preflight.approve(decision.decisionId, approver);
      this.log(`[human] approved by ${approver}.`);
    }
    const execution = await this.preflight.execute(decision.decisionId);
    this.log(`[wallet] ${execution.status === "failed" ? "execution failed" : "signed in custody enclave"}: ${execution.status}${execution.txHash ? ` tx=${execution.txHash}` : ""}`);
    return execution.status === "failed" ? { outcome: "failed", decision, execution } : { outcome: "executed", decision, execution };
  }
}

function short(assetId: string): string {
  const id = assetId.replace(/^nep141:/, "");
  return id.length > 20 ? `${id.slice(0, 8)}…` : id;
}
