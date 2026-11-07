#!/usr/bin/env tsx
/**
 * A public SeIn on testnet, for Cloud Run or any container host. Visitors of the website try the
 * firewall through POST /v1/try; real checks, a real custody wallet, test tokens only.
 * Settings come from the environment (secrets from the host's secret store), because the disk is
 * thrown away on every restart. Deploy with scripts/deploy-cloudrun.sh.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSealedPolicy } from "@sealed-intent/core";
import { startGateway } from "./gateway";
import { policyFrom, type Network } from "./setup";

const need = (name: string) => {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return v;
};
const network: Network = process.env.SEALED_NETWORK === "mainnet" ? "mainnet" : "testnet";
process.env.SEALED_NETWORK = network;
process.env.SEALED_MODE ??= "live";
process.env.OUTLAYER_BASE_URL ??= network === "testnet" ? "https://testnet-api.outlayer.ai" : "https://api.outlayer.ai";
process.env.NEAR_RPC_URL ??= network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com";
process.env.SEALED_WEB_ORIGINS ??= "https://sein-near.vercel.app";

const wallet = need("OUTLAYER_NEAR_ACCOUNT");
need("OUTLAYER_API_KEY");
need("NEARAI_API_KEY");
const owner = need("SEIN_DEMO_OWNER");
process.env.SEALED_OWNER_ACCOUNT ??= owner;

mkdirSync(".sealed", { recursive: true, mode: 0o700 });
// the receipt signing key must survive restarts, or yesterday's receipts would name a key nobody lists
if (process.env.SEALED_ISSUER_PEM) writeFileSync(join(".sealed", "issuer.pem"), process.env.SEALED_ISSUER_PEM.replace(/\\n/g, "\n"), { mode: 0o600 });
const policy = policyFrom({
  network,
  owner,
  wallet,
  perPaymentUsd: Number(process.env.SEIN_DEMO_PER_PAYMENT_USD ?? 0.05),
  dailyUsd: Number(process.env.SEIN_DEMO_DAILY_USD ?? 2),
  receivers: (process.env.SEIN_DEMO_RECEIVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  newReceiver: "warn",
  tokens: ["NEAR"],
  enclave: true,
});
writeSealedPolicy(join(".sealed", "policy.sealed.json"), policy, need("SEALED_POLICY_KEY"));

startGateway({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  demo: {
    agentId: "website-visitor",
    network,
    perVisitor: Number(process.env.SEIN_DEMO_PER_VISITOR ?? 6),
    perDay: Number(process.env.SEIN_DEMO_PER_DAY ?? 300),
    paymentsPerDay: Number(process.env.SEIN_DEMO_PAYMENTS_PER_DAY ?? 40),
  },
});
