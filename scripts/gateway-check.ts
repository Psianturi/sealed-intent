#!/usr/bin/env tsx
/**
 * Runs the real gateway process on testnet from an empty folder and drives it the way an agent and
 * an owner would, including the MCP bridge. Test tokens only. Writes evidence/custody-testnet/gateway-run.json.
 *   pnpm gateway:check
 */
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Near, generateNonce } from "near-kit";
import { approvalMessage, APPROVAL_RECIPIENT, loadEnv, NATIVE, requestToSign, reviewHash, sealPolicy } from "@sealed-intent/core";
import { testnetPolicy } from "./testnet-policy";

loadEnv();
const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is missing from .env`);
  return v;
};
if (process.env.SEALED_NETWORK !== "testnet") throw new Error("testnet only");
const repo = process.cwd();
const VENDOR = need("SEIN_TESTNET_VENDOR_ACCOUNT");
const OWNER = need("SEIN_TESTNET_OWNER_ACCOUNT");
const WALLET = need("OUTLAYER_NEAR_ACCOUNT");
const RPC = need("NEAR_RPC_URL");
const PORT = 8799;
const base = `http://127.0.0.1:${PORT}`;
const ownerToken = randomBytes(24).toString("hex");
const sleep = (ms: number) => new Promise((d) => setTimeout(d, ms));
const yocto = (n: number) => (BigInt(Math.round(n * 100000)) * 10n ** 19n).toString();

// an empty working folder: the gateway's own state, and the secrets only in its environment
const cwd = mkdtempSync(join(tmpdir(), "sein-gateway-"));
mkdirSync(join(cwd, ".sealed"), { recursive: true, mode: 0o700 });
writeFileSync(join(cwd, ".sealed", "policy.sealed.json"), JSON.stringify(sealPolicy(testnetPolicy(WALLET, VENDOR), need("SEALED_POLICY_KEY"))), { mode: 0o600 });
const tsx = resolve(repo, "node_modules", "tsx", "dist", "cli.mjs");
const { SEIN_TESTNET_OWNER_KEY: _a, SEIN_TESTNET_VENDOR_KEY: _b, SEIN_TESTNET_ATTACKER_KEY: _c, SEIN_REGISTRY_KEY: _d, OUTLAYER_HANDOFF_URL: _e, ...serverEnv } = process.env;
const server: ChildProcess = spawn(process.execPath, [tsx, resolve(repo, "apps", "server", "src", "rest.ts")], {
  cwd,
  env: { ...serverEnv, SEALED_MODE: "live", PORT: String(PORT), SEALED_OWNER_TOKEN: ownerToken, SEALED_OWNER_ACCOUNT: OWNER, SEALED_RECONCILE_INTERVAL_MS: "20000", SEALED_ANCHOR_INTERVAL_MS: "45000", SEALED_AGENT_REGISTRY: "gateway-agent=agent-1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const log: string[] = [];
server.stdout!.on("data", (d) => log.push(String(d)));
server.stderr!.on("data", (d) => log.push(String(d)));

const results: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok " : "!! "} ${name}${detail !== undefined ? ` (${JSON.stringify(detail).slice(0, 110)})` : ""}`);
};

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const agentKeyHex = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
const seedHex = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32).toString("hex");
type Json = Record<string, any>;
const ownerPost = async (path: string, data: unknown = {}): Promise<Json> => {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` }, body: JSON.stringify(data) });
  return { http: r.status, ...((await r.json()) as Json) };
};
let agentToken = "";
const agentPost = async (path: string, data: unknown, extra: Record<string, string> = {}, signed = true): Promise<Json> => {
  const raw = JSON.stringify(data);
  const timestamp = String(Date.now());
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}`, ...extra };
  if (signed) Object.assign(headers, { "X-SeIn-Timestamp": timestamp, "X-SeIn-Signature": sign(null, Buffer.from(requestToSign(timestamp, "POST", path, raw)), privateKey).toString("hex") });
  const r = await fetch(base + path, { method: "POST", headers, body: raw });
  return { http: r.status, replay: r.headers.get("Idempotent-Replay"), version: r.headers.get("SeIn-Api-Version"), ...((await r.json()) as Json) };
};
const status = async () => (await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json() as Promise<Json>;
const pay = (over: Record<string, unknown> = {}) => ({ kind: "transfer", token: NATIVE, amount: yocto(0.001), recipient: VENDOR, purpose: "general", taskText: "Pay the vendor invoice for October as agreed with finance.", ...over });

let bridgeClient: Client | undefined;
try {
  for (let i = 0; i < 60; i++) {
    const up = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
    if (up) break;
    await sleep(1000);
  }
  const health = (await (await fetch(`${base}/health`)).json()) as Json;
  check("the gateway starts in live mode from an empty folder", health.mode === "live", health);
  await sleep(3000);

  const issued = await ownerPost("/v1/agents/issue", { agentId: "gateway-agent", agentKey: agentKeyHex });
  agentToken = issued.token;
  check("the owner issues an agent token", typeof agentToken === "string" && agentToken.length === 64);
  check("a stolen token alone is refused", (await agentPost("/v1/preflight", { intent: pay() }, {}, false)).http === 401);

  const first = await agentPost("/v1/preflight", { intent: pay() }, { "Idempotency-Key": "gateway-pay-1" });
  check("a routine payment is allowed by the enclave and the rules", first.verdict === "ALLOW", { verdict: first.verdict, warn: first.warnCodes });
  const again = await agentPost("/v1/preflight", { intent: pay() }, { "Idempotency-Key": "gateway-pay-1" });
  check("repeating the request returns the first decision", again.decisionId === first.decisionId && again.replay === "true");
  check("the agent is told nothing about receipts on disk or metrics", first.receiptPath === undefined && first.metrics === undefined);
  check("answers carry the API version", first.version === "1");

  const paid = await agentPost("/v1/execute", { decisionId: first.decisionId }, { "Idempotency-Key": "gateway-exec-1" });
  check("the payment goes through custody and is final on chain", paid.status === "submitted" && paid.chain?.final === true, { status: paid.status, tx: paid.txHash, signer: paid.chain?.signer });
  const paidAgain = await agentPost("/v1/execute", { decisionId: first.decisionId }, { "Idempotency-Key": "gateway-exec-1" });
  check("repeating the payment does not pay twice", paidAgain.txHash === paid.txHash && paidAgain.replay === "true");

  const receipt = (await (await fetch(`${base}/v1/receipts/${first.decisionId}`)).json()) as Json;
  check("the public receipt names the network and the registered agent, and seals the rest", receipt.public?.network === "testnet" && receipt.public?.registeredAgent === "agent-1" && !JSON.stringify(receipt).includes(VENDOR));

  await sleep(25_000);
  check("reconciliation stays quiet about a payment SeIn sent", (await status()).frozen === false);

  // an approval the owner signs
  const warned = await agentPost("/v1/preflight", { intent: pay({ recipient: OWNER, taskText: "Send the monthly refund to the treasury account we opened this week." }) });
  check("a new receiver needs the owner", warned.verdict === "WARN", { verdict: warned.verdict, codes: warned.reasonCodes, warn: warned.warnCodes });
  if (warned.verdict === "WARN") {
    const tokenOnly = await ownerPost("/v1/approve", { decisionId: warned.decisionId, approver: "me" });
    check("the owner token alone cannot approve", tokenOnly.http === 401);
    const pending = (await (await fetch(`${base}/v1/pending`, { headers: { Authorization: `Bearer ${ownerToken}` } })).json()) as Json[];
    const review = pending.find((r) => r.decisionId === warned.decisionId);
    check("the owner can read what is being asked", !!review && review.recipient === OWNER, { kind: review?.kind, usd: review?.usd });
    const near = new Near({ network: { networkId: "testnet", rpcUrl: RPC }, privateKey: need("SEIN_TESTNET_OWNER_KEY") as `ed25519:${string}`, defaultSignerId: OWNER });
    const nonce = generateNonce();
    const s = await near.signMessage({ message: approvalMessage("approve", warned.decisionId, reviewHash(review as never)), recipient: APPROVAL_RECIPIENT, nonce }, { signerId: OWNER });
    const signed = { action: "approve", decisionId: warned.decisionId, accountId: OWNER, publicKey: s.publicKey, signature: s.signature, nonce: Buffer.from(nonce).toString("base64") };
    const forged = await ownerPost("/v1/approve", { decisionId: warned.decisionId, signed: { ...signed, signature: signed.signature.replace(/.{4}$/, "1111") } });
    check("a changed signature is refused", forged.http === 401);
    const ok = await ownerPost("/v1/approve", { decisionId: warned.decisionId, signed });
    check("the owner's wallet signature approves", ok.ok === true);
    const x = await agentPost("/v1/execute", { decisionId: warned.decisionId });
    check("the approved payment is sent", x.status === "submitted", { tx: x.txHash });
  }

  // the agent bridge, as an agent host runs it, with only its own token and key
  const transport = new StdioClientTransport({ command: process.execPath, args: [tsx, resolve(repo, "apps", "server", "src", "mcp-agent.ts")], cwd, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", SEALED_REST_URL: base, SEALED_AGENT_TOKEN: agentToken, SEALED_AGENT_SIGNING_KEY: seedHex } });
  bridgeClient = new Client({ name: "gateway-check", version: "1" });
  await bridgeClient.connect(transport);
  const tools = (await bridgeClient.listTools()).tools.map((t) => t.name);
  check("the bridge lists its tools and none approves", tools.includes("preflight_transfer") && !tools.some((t) => /approve|unfreeze|freeze/.test(t)), tools);
  const viaBridge = await bridgeClient.callTool({ name: "preflight_transfer", arguments: { token: NATIVE, amount: yocto(0.001), recipient: VENDOR, taskText: "Pay the vendor invoice for October as agreed with finance." } });
  const bridgeText = (viaBridge.content as { text: string }[])[0]?.text ?? "";
  check("a signed request through the bridge reaches a decision", /"verdict":\s*"(ALLOW|WARN)"/.test(bridgeText), bridgeText.match(/"verdict":\s*"\w+"/)?.[0]);

  // batches
  for (let i = 0; i < 12; i++) {
    const proof = await fetch(`${base}/v1/proofs/${first.decisionId}`);
    if (proof.ok) {
      const p = (await proof.json()) as Json;
      check("receipts are anchored by the running gateway", typeof p.anchorIndex === "number" && p.anchorIndex >= 0, { anchorIndex: p.anchorIndex, tx: p.anchorTx });
      break;
    }
    if (i === 11) check("receipts are anchored by the running gateway", false);
    await sleep(10_000);
  }

  const revoke = await ownerPost("/v1/agents/revoke", { agentId: "gateway-agent" });
  check("the owner revokes the agent", revoke.ok === true);
  check("the revoked token stops working at once", (await agentPost("/v1/preflight", { intent: pay() })).http === 401);

  const frozen = await ownerPost("/v1/freeze", { reason: "gateway check" });
  check("the owner's freeze reaches custody on chain", frozen.frozen === true && typeof frozen.custodyFreeze === "string", frozen.custodyFreeze);
  await sleep(4000);
  const onChain = await fetch(`${need("OUTLAYER_BASE_URL")}/wallet/v1/policy`, { headers: { Authorization: `Bearer ${need("OUTLAYER_API_KEY")}` } }).then((r) => r.json() as Promise<Json>);
  check("custody now reports the wallet as frozen", onChain.frozen === true);
  const near = new Near({ network: { networkId: "testnet", rpcUrl: RPC }, privateKey: need("SEIN_TESTNET_OWNER_KEY") as `ed25519:${string}`, defaultSignerId: OWNER });
  await near.transaction(OWNER).functionCall("outlayer.testnet", "unfreeze_wallet", { wallet_pubkey: `ed25519:${WALLET}` }, { gas: "50 Tgas" }).send();
  check("the owner unfreezes", (await ownerPost("/v1/unfreeze")).ok === true);

  const secrets = [need("OUTLAYER_API_KEY"), need("NEARAI_API_KEY"), need("SEIN_OPERATOR_KEY"), need("SEIN_FREEZE_KEY"), need("SEALED_POLICY_KEY"), ownerToken, agentToken];
  check("the gateway's log holds no secret and no receiver", !secrets.some((v) => log.join("").includes(v)) && !log.join("").includes(VENDOR));
} finally {
  await bridgeClient?.close().catch(() => undefined);
  server.kill();
}
const passed = results.filter((r) => r.ok).length;
writeFileSync(join(repo, "evidence", "custody-testnet", "gateway-run.json"), JSON.stringify({ ranAt: new Date().toISOString(), network: "testnet", passed, total: results.length, results }, null, 2) + "\n");
console.log(`\n${passed} of ${results.length} as expected.`);
process.exit(passed === results.length ? 0 : 1);
