#!/usr/bin/env tsx
/**
 * The owner's kill switch and approval tool, talking to a running REST server.
 *
 *   pnpm owner status
 *   pnpm owner freeze [reason]            stop every payment until unfreeze
 *   pnpm owner unfreeze
 *   pnpm owner pending                    what is waiting for you: amount, receiver, why, and what a private route hides
 *   pnpm owner approve <decisionId> [name]
 *   pnpm owner reject <decisionId> [name]
 *   pnpm owner accept-code <account>      accept a contract's current code after COUNTERPARTY_CODE_CHANGED
 *   pnpm owner confirm-blocklist <account>
 *   pnpm owner watch-accept <account>     accept the account's keys and code as they are now
 *   pnpm owner reconcile-accept           accept the wallet's transaction history as it is now
 *   pnpm owner approve-signed <decisionId> [reject]   sign with the owner wallet key (SEALED_OWNER_NEAR_KEY)
 *   pnpm owner agent-issue <agentId> [agentKeyHex]    prints a new token once
 *   pnpm owner agent-revoke <agentId>
 *
 * Needs SEALED_OWNER_TOKEN (printed by `pnpm rest` when not set) and optionally SEALED_REST_URL.
 */
import { loadEnv } from "@sealed-intent/core";

loadEnv();
const base = process.env.SEALED_REST_URL ?? "http://127.0.0.1:8787";
const token = process.env.SEALED_OWNER_TOKEN;
const [cmd, ...args] = process.argv.slice(2);

async function call(method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

function need(name: string, v: string | undefined): string {
  if (!v) {
    console.error(`${name} required`);
    process.exit(2);
  }
  return v;
}

try {
  if (cmd !== "status" && !token) {
    console.error("SEALED_OWNER_TOKEN is not set (put it in .env; `pnpm rest` prints a generated one)");
    process.exit(2);
  }
  switch (cmd) {
    case "status":
      console.log(JSON.stringify(await call("GET", "/v1/status"), null, 2));
      break;
    case "freeze":
      console.log(JSON.stringify(await call("POST", "/v1/freeze", { reason: args.join(" ") || "owner request" }), null, 2));
      break;
    case "unfreeze":
      console.log(JSON.stringify(await call("POST", "/v1/unfreeze"), null, 2));
      break;
    case "pending":
      console.log(JSON.stringify(await call("GET", "/v1/pending"), null, 2));
      break;
    case "watch-accept":
      console.log(JSON.stringify(await call("POST", "/v1/watch/accept", { account: need("account", args[0]) }), null, 2));
      break;
    case "approve-signed": {
      const { approvalMessage, APPROVAL_RECIPIENT, reviewHash } = await import("@sealed-intent/core");
      const { Near, generateNonce } = await import("near-kit");
      const decisionId = need("decisionId", args[0]);
      const action = args[1] === "reject" ? "reject" : "approve";
      const accountId = need("SEALED_OWNER_ACCOUNT", process.env.SEALED_OWNER_ACCOUNT);
      const review = ((await call("GET", "/v1/pending")) as { decisionId: string }[]).find((r) => r.decisionId === decisionId);
      if (!review) throw new Error("that decision is not waiting for you");
      console.log("You are signing for:", JSON.stringify(review, null, 2));
      const near = new Near({ network: { networkId: process.env.SEALED_NETWORK === "testnet" ? "testnet" : "mainnet", rpcUrl: process.env.NEAR_RPC_URL ?? "https://free.rpc.fastnear.com" }, privateKey: need("SEALED_OWNER_NEAR_KEY", process.env.SEALED_OWNER_NEAR_KEY) as `ed25519:${string}`, defaultSignerId: accountId });
      const nonce = generateNonce();
      const s = await near.signMessage({ message: approvalMessage(action, decisionId, reviewHash(review as never)), recipient: APPROVAL_RECIPIENT, nonce }, { signerId: accountId });
      const signed = { action, decisionId, accountId, publicKey: s.publicKey, signature: s.signature, nonce: Buffer.from(nonce).toString("base64") };
      console.log(JSON.stringify(await call("POST", `/v1/${action}`, { decisionId, signed }), null, 2));
      break;
    }
    case "agent-issue":
      console.log(JSON.stringify(await call("POST", "/v1/agents/issue", { agentId: need("agentId", args[0]), agentKey: args[1] }), null, 2));
      break;
    case "agent-revoke":
      console.log(JSON.stringify(await call("POST", "/v1/agents/revoke", { agentId: need("agentId", args[0]) }), null, 2));
      break;
    case "reconcile-accept":
      console.log(JSON.stringify(await call("POST", "/v1/reconcile/accept"), null, 2));
      break;
    case "approve":
    case "reject":
      console.log(JSON.stringify(await call("POST", `/v1/${cmd}`, { decisionId: need("decisionId", args[0]), approver: args[1] ?? "owner" }), null, 2));
      break;
    case "accept-code":
      console.log(JSON.stringify(await call("POST", "/v1/counterparty/accept-code", { account: need("account", args[0]) }), null, 2));
      break;
    case "confirm-blocklist":
      console.log(JSON.stringify(await call("POST", "/v1/blocklist/confirm", { account: need("account", args[0]) }), null, 2));
      break;
    default:
      console.log("usage: pnpm owner status|pending|freeze [reason]|unfreeze|approve <id>|reject <id>|accept-code <account>|confirm-blocklist <account>|watch-accept <account>");
      process.exit(2);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
