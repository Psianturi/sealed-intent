#!/usr/bin/env tsx
/**
 * Owner-side custody steps on OutLayer testnet. Test tokens only.
 *   pnpm custody accounts           create the test owner, vendor and attacker from the faucet
 *   pnpm custody policy <file>      encrypt, sign and store a policy, sent by the owner account
 *   pnpm custody fund <near>        send NEAR from the owner to the custody wallet
 *   pnpm custody status             wallet, policy, balances
 *   pnpm custody freeze | unfreeze  on-chain, controller only
 *   pnpm custody freeze-key         add a key that can only freeze, for the SeIn server
 */
import { appendFileSync, readFileSync } from "node:fs";
import { generateKey, Near } from "near-kit";
import { loadEnv } from "@sealed-intent/receipt";

loadEnv();
const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const OUTLAYER = process.env.OUTLAYER_BASE_URL ?? "";
const KEY = process.env.OUTLAYER_API_KEY ?? "";
const CONTRACT = "outlayer.testnet";
if (!OUTLAYER.includes("testnet")) throw new Error("this script only runs against OutLayer testnet");

const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is missing from .env`);
  return v;
};
const owner = () => new Near({ network: { networkId: "testnet", rpcUrl: RPC }, privateKey: env("SEIN_TESTNET_OWNER_KEY") as `ed25519:${string}`, defaultSignerId: env("SEIN_TESTNET_OWNER_ACCOUNT") });

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${OUTLAYER}${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function createAccounts() {
  const suffix = Date.now().toString(36);
  for (const role of ["OWNER", "VENDOR", "ATTACKER"]) {
    if (process.env[`SEIN_TESTNET_${role}_ACCOUNT`]) continue;
    const account = `sein-${role.toLowerCase()}-${suffix}.testnet`;
    const key = generateKey();
    const res = await fetch("https://helper.testnet.near.org/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newAccountId: account, newAccountPublicKey: key.publicKey.toString() }) });
    if (!res.ok) throw new Error(`faucet ${res.status}: ${(await res.text()).slice(0, 200)}`);
    appendFileSync(".env", `SEIN_TESTNET_${role}_ACCOUNT=${account}\nSEIN_TESTNET_${role}_KEY=${key.secretKey}\n`);
    console.log("created", account);
  }
}

async function applyPolicy(file: string) {
  const policy = JSON.parse(readFileSync(file, "utf8"));
  const caller = env("SEIN_TESTNET_OWNER_ACCOUNT");
  const walletId = env("OUTLAYER_WALLET_ID");
  const enc = await api<{ encrypted_base64: string; wallet_pubkey: string }>("/wallet/v1/encrypt-policy", { wallet_id: walletId, ...policy });
  const signed = await api<{ signature_hex: string; public_key_hex: string }>("/wallet/v1/sign-policy", { encrypted_data: enc.encrypted_base64, caller });
  const pub = `ed25519:${signed.public_key_hex}`;
  const near = owner();
  const cost = await near.view<string>(CONTRACT, "estimate_wallet_policy_cost", { wallet_pubkey: pub, encrypted_data: enc.encrypted_base64 });
  const tx = await near.transaction(caller).functionCall(CONTRACT, "store_wallet_policy", { wallet_pubkey: pub, encrypted_data: enc.encrypted_base64, wallet_signature: signed.signature_hex }, { gas: "100 Tgas", attachedDeposit: `${BigInt(cost ?? "100000000000000000000000")} yocto` }).send();
  console.log("stored, tx", tx.transaction.hash);
  await fetch(`${OUTLAYER}/wallet/v1/invalidate-cache`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wallet_id: walletId }) });
}

async function status() {
  const p = await api<Record<string, unknown>>("/wallet/v1/policy");
  const bal = await api<{ balance: string }>("/wallet/v1/balance?chain=near");
  console.log(JSON.stringify({ policy: p.policy, frozen: p.frozen, controller: p.controller, owner: p.owner, rules: p.rules, capabilities: p.capabilities, usage: p.usage, nativeYocto: bal.balance }, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
const pub = `ed25519:${env("OUTLAYER_NEAR_ACCOUNT")}`;
if (cmd === "accounts") await createAccounts();
else if (cmd === "policy") await applyPolicy(arg!);
else if (cmd === "status") await status();
else if (cmd === "freeze-key") {
  if (process.env.SEIN_FREEZE_KEY) console.log("already set");
  else {
    const owner_ = env("SEIN_TESTNET_OWNER_ACCOUNT");
    const key = generateKey();
    await owner().transaction(owner_).addKey(key.publicKey.toString(), { type: "functionCall", receiverId: CONTRACT, methodNames: ["freeze_wallet"], allowance: "0.25 NEAR" }).send();
    appendFileSync(".env", `SEIN_FREEZE_ACCOUNT=${owner_}\nSEIN_FREEZE_KEY=${key.secretKey}\n`);
    console.log("freeze-only key added to", owner_);
  }
}
else if (cmd === "fund") console.log("tx", (await owner().transaction(env("SEIN_TESTNET_OWNER_ACCOUNT")).transfer(env("OUTLAYER_NEAR_ACCOUNT"), `${arg} NEAR` as never).send()).transaction.hash);
else if (cmd === "freeze" || cmd === "unfreeze") console.log("tx", (await owner().transaction(env("SEIN_TESTNET_OWNER_ACCOUNT")).functionCall(CONTRACT, `${cmd}_wallet`, { wallet_pubkey: pub }, { gas: "50 Tgas" }).send()).transaction.hash);
else console.log("usage: pnpm custody accounts | policy <file> | fund <near> | status | freeze | unfreeze");
