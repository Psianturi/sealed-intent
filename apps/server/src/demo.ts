// The public "try the firewall" route of a hosted SeIn: a visitor plays the agent, and the real checks answer.
import type { Preflight, ReceiptStore } from "@sealed-intent/core";
import { tokenOf, toSmallest, type Network } from "./setup";

export interface DemoOptions {
  agentId: string;
  network: Network;
  /** requests one visitor may make in ten minutes */
  perVisitor: number;
  /** requests everyone together may make in a day, so the enclave bill stays small */
  perDay: number;
  /** allowed payments that are really sent in a day; the custody service counts operations too */
  paymentsPerDay: number;
}

export interface Demo {
  handle(visitor: string, body: Record<string, unknown>, now?: number): Promise<{ status: number; body: unknown }>;
  quota(now?: number): { requestsLeft: number; paymentsLeft: number };
}

const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const explorer = (network: Network, hash: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/txns/${hash}`;

export function createDemo(deps: { preflight: Preflight; store: ReceiptStore }, opts: DemoOptions): Demo {
  const visits = new Map<string, number[]>();
  let today = "";
  let requests = 0;
  let payments = 0;
  const roll = (now: number) => {
    if (day(now) !== today) [today, requests, payments] = [day(now), 0, 0];
  };

  const quota = (now = Date.now()) => {
    roll(now);
    return { requestsLeft: Math.max(0, opts.perDay - requests), paymentsLeft: Math.max(0, opts.paymentsPerDay - payments) };
  };

  return {
    quota,
    async handle(visitor, body, now = Date.now()) {
      roll(now);
      const recent = (visits.get(visitor) ?? []).filter((t) => now - t < 600_000);
      if (recent.length >= opts.perVisitor) return { status: 429, body: { error: "You have tried a lot in a few minutes. Wait a little and try again." } };
      if (requests >= opts.perDay) return { status: 429, body: { error: "Today's demo checks are used up. Come back tomorrow, or run SeIn yourself." } };

      const to = String(body.to ?? "").trim().toLowerCase();
      const token = tokenOf(opts.network, String(body.token ?? "NEAR"));
      const taskText = String(body.taskText ?? "").slice(0, 1000);
      if (!/^[a-z0-9._-]{2,64}$/.test(to)) return { status: 400, body: { error: "The receiver must be a NEAR account name." } };
      if (!token) return { status: 400, body: { error: "Use NEAR, USDC or wNEAR." } };
      let amount: string;
      try {
        amount = toSmallest(String(body.amount ?? ""), token.decimals);
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
      if (BigInt(amount) > 10n ** BigInt(token.decimals + 6)) return { status: 400, body: { error: "That amount is not realistic." } };

      visits.set(visitor, [...recent, now]);
      requests++;
      const intent = { kind: "transfer", token: token.assetId, amount, recipient: to, taskText };
      let d = await deps.preflight.evaluate({ agentId: opts.agentId, intent });
      // the enclave service sometimes answers too late; SeIn then blocks, and an agent may simply ask again
      if (d.reasonCodes.includes("TEE_UNAVAILABLE")) d = await deps.preflight.evaluate({ agentId: opts.agentId, intent });
      let execution: Record<string, unknown> | undefined;
      if (d.verdict === "ALLOW") {
        if (payments >= opts.paymentsPerDay) execution = { status: "not_sent", note: "Allowed. Today's real demo payments are used up, so this one was not sent." };
        else {
          payments++;
          const x = await deps.preflight.execute(d.decisionId, opts.agentId);
          execution = { status: x.status, txHash: x.txHash, explorer: x.txHash ? explorer(opts.network, x.txHash) : undefined, refusedByCustody: x.refusedByCustody, executionReceipt: x.executionReceiptId ? deps.store.load(x.executionReceiptId) : undefined };
        }
      }
      // the requester may see the openings of what they typed themselves, and nothing else: never the policy's
      const opened = deps.store.loadOpenings(d.decisionId)?.openings ?? {};
      const yours = Object.fromEntries((["recipient", "amountIn", "tokenIn", "taskText"] as const).filter((k) => opened[k]).map((k) => [k, opened[k]]));
      return {
        status: 200,
        body: {
          openings: yours,
          decisionId: d.decisionId,
          verdict: d.verdict,
          reasonCodes: d.reasonCodes,
          warnCodes: d.warnCodes,
          note: d.verdict === "WARN" ? "In real use this waits for the owner's wallet signature. The demo stops here." : undefined,
          receipt: deps.store.load(d.decisionId),
          execution,
          network: opts.network,
          quota: quota(now),
        },
      };
    },
  };
}
