#!/usr/bin/env tsx
/**
 * What an agent host runs in real use. It holds one agent token and forwards to the REST service,
 * which runs as another OS user with the custody key, the policy and the owner token. It reads no
 * .env, and it refuses to start if a secret reached its environment.
 *
 *   SEALED_REST_URL=http://127.0.0.1:8787 SEALED_AGENT_TOKEN=... pnpm mcp:agent
 */
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { requestToSign } from "@sealed-intent/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools";

const SECRETS = ["OUTLAYER_API_KEY", "SEALED_POLICY_KEY", "SEALED_DATA_KEY", "SEALED_OWNER_TOKEN", "SEALED_AGENT_TOKENS", "NEARAI_API_KEY", "ONECLICK_JWT", "SEIN_OPERATOR_KEY", "SEIN_FREEZE_KEY"];
const leaked = SECRETS.filter((k) => process.env[k]);
if (leaked.length) {
  console.error(`Refusing to start: the agent's environment must not hold ${leaked.join(", ")}.`);
  process.exit(3);
}
const base = process.env.SEALED_REST_URL ?? "http://127.0.0.1:8787";
const token = process.env.SEALED_AGENT_TOKEN;
if (!token) {
  console.error("SEALED_AGENT_TOKEN is required.");
  process.exit(2);
}

// a 32-byte hex seed; with it, a stolen token alone cannot speak for this agent
const seed = process.env.SEALED_AGENT_SIGNING_KEY;
const signingKey = seed ? createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed, "hex")]), format: "der", type: "pkcs8" }) : undefined;

async function call(method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> {
  const raw = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = String(Date.now());
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      // a retry of this exact request is then not acted on twice
      ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}),
      ...(signingKey ? { "X-SeIn-Timestamp": timestamp, "X-SeIn-Signature": sign(null, Buffer.from(requestToSign(timestamp, method, path, raw)), signingKey).toString("hex") } : {}),
    },
    body: raw || undefined,
  });
  return res.json();
}

const server = new McpServer({ name: "sealed-intent", version: "0.1.0" });
registerTools(server, {
  preflight: (intent) => call("POST", "/v1/preflight", { intent }),
  execute: (decisionId) => call("POST", "/v1/execute", { decisionId }),
  report: (args) => call("POST", "/v1/blocklist/report", args),
  receipt: (decisionId) => call("GET", `/v1/receipts/${encodeURIComponent(decisionId)}`),
  lessons: () => call("GET", "/v1/lessons"),
}, process.env.SEALED_NETWORK === "testnet" ? "testnet" : "mainnet");
await server.connect(new StdioServerTransport());
