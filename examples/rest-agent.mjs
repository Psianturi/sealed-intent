#!/usr/bin/env node
// A minimal agent in plain Node that pays through SeIn's REST API. No dependencies.
//
//   node examples/rest-agent.mjs my-sein/agents/shop-bot/agent.env pay bob.near 0.01 NEAR "Pay Bob for the October invoice"
//   node examples/rest-agent.mjs my-sein/agents/shop-bot/agent.env finish <decisionId>
//
// agent.env is written by `pnpm sein connect <name>`. It holds only this agent's token and signing key.
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const [envFile, cmd, ...args] = process.argv.slice(2);
const env = Object.fromEntries(readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(env.SEALED_AGENT_SIGNING_KEY, "hex")]), format: "der", type: "pkcs8" });

// every request is signed: timestamp, method, path and a hash of the body
async function sein(path, body, idempotencyKey = randomUUID()) {
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const digest = createHash("sha256").update(raw).digest("hex");
  const res = await fetch(`${env.SEALED_REST_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.SEALED_AGENT_TOKEN}`,
      "Idempotency-Key": idempotencyKey,
      "X-SeIn-Timestamp": ts,
      "X-SeIn-Signature": sign(null, Buffer.from(`${ts}.POST.${path}.${digest}`), key).toString("hex"),
    },
    body: raw,
  });
  return res.json();
}

const TOKENS = {
  mainnet: { NEAR: ["native", 24], WNEAR: ["nep141:wrap.near", 24], USDC: ["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", 6] },
  testnet: { NEAR: ["native", 24], WNEAR: ["nep141:wrap.testnet", 24], USDC: ["nep141:usdc.fakes.testnet", 6] },
};
const smallest = (amount, decimals) => {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals)).toString();
};

function report(decisionId, x) {
  if (x.status === "submitted" || x.status === "simulated") console.log(`Paid. Transaction ${x.txHash ?? "(simulated)"}`);
  else if (/approval/.test(String(x.details ?? ""))) console.log(`Still waiting for the owner. Run again later: finish ${decisionId}`);
  else console.log("Not sent:", JSON.stringify(x));
}

if (cmd === "pay") {
  const [to, amount, symbol = "NEAR", ...task] = args;
  const [token, decimals] = TOKENS[env.SEALED_NETWORK === "testnet" ? "testnet" : "mainnet"][symbol.toUpperCase()] ?? [];
  if (!token) throw new Error("token must be NEAR, USDC or wNEAR");
  const d = await sein("/v1/preflight", { intent: { kind: "transfer", token, amount: smallest(amount, decimals), recipient: to, taskText: task.join(" ") || `Pay ${amount} ${symbol} to ${to}` } });
  if (d.verdict === "ALLOW") report(d.decisionId, await sein("/v1/execute", { decisionId: d.decisionId }, `pay-${d.decisionId}`));
  else if (d.verdict === "WARN") console.log(`Waiting for the owner to approve with their wallet. Then run: finish ${d.decisionId}`);
  else console.log(`Refused, nothing sent: ${(d.reasonCodes ?? [d.error]).join(", ")}`);
} else if (cmd === "finish") {
  // a fresh key each time: SeIn itself never pays one decision twice
  report(args[0], await sein("/v1/execute", { decisionId: args[0] }));
} else {
  console.log("usage: rest-agent.mjs <agent.env> pay <to> <amount> [NEAR|USDC|wNEAR] [task text] | finish <decisionId>");
}
