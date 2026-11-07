#!/usr/bin/env tsx
/**
 * A testnet account with planted problems, so the checkpoint has something real to find and heal.
 * Test tokens only. The keys stay in .env.
 *   pnpm checkup:patient         create it if needed, then plant whatever problem is missing
 *   pnpm checkup:patient heal    cut the bad connections with the account's key, as the page does with a wallet
 */
import { appendFileSync } from "node:fs";
import { generateKey, Near } from "near-kit";
import { loadEnv } from "@sealed-intent/core";

loadEnv();
const RPC = "https://test.rpc.fastnear.com";
const near = (account: string, key: string) => new Near({ network: { networkId: "testnet", rpcUrl: RPC }, privateKey: key as `ed25519:${string}`, defaultSignerId: account });

let account = process.env.SEIN_PATIENT_ACCOUNT;
let key = process.env.SEIN_PATIENT_KEY;
if (!account || !key) {
  account = `sein-patient-${Date.now().toString(36)}.testnet`;
  const k = generateKey();
  const res = await fetch("https://helper.testnet.near.org/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newAccountId: account, newAccountPublicKey: k.publicKey.toString() }) });
  if (!res.ok) throw new Error(`faucet ${res.status}: ${(await res.text()).slice(0, 200)}`);
  key = k.secretKey;
  appendFileSync(".env", `SEIN_PATIENT_ACCOUNT=${account}\nSEIN_PATIENT_KEY=${key}\n`);
  console.log("created", account);
  await new Promise((d) => setTimeout(d, 4000));
}

const attacker = process.env.SEIN_TESTNET_ATTACKER_ACCOUNT ?? "sein-attacker-mvy1eh5f.testnet";
// what an unlucky wallet collects: a look-alike app, a reported account, an app that was deleted, one normal app
const connections = ["wrap-testnet.testnet", attacker, `gone-app-${account.split("-").pop()!.replace(".testnet", "")}.testnet`, "outlayer.testnet"];
type Key = { public_key: string; access_key: { permission: "FullAccess" | { FunctionCall: { receiver_id: string } } } };
const res = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: account } }) });
const keys = ((await res.json()) as { result: { keys: Key[] } }).result.keys;
const receiverOf = (k: Key) => (k.access_key.permission === "FullAccess" ? undefined : k.access_key.permission.FunctionCall.receiver_id);

if (process.argv[2] === "heal") {
  const bad = keys.filter((k) => receiverOf(k) && receiverOf(k) !== "outlayer.testnet");
  if (!bad.length) console.log("nothing to cut");
  else {
    let tx = near(account, key).transaction(account);
    for (const k of bad) tx = tx.deleteKey(account, k.public_key);
    console.log(`cut ${bad.length} connection(s), tx`, (await tx.send()).transaction.hash);
  }
} else {
  let tx = near(account, key).transaction(account);
  let planted = 0;
  for (const receiverId of connections.filter((r) => !keys.some((k) => receiverOf(k) === r))) {
    tx = tx.addKey(generateKey().publicKey.toString(), { type: "functionCall", receiverId, methodNames: [], allowance: "0.25 NEAR" });
    planted++;
  }
  // a second key that can do anything, which the owner should recognise or remove
  if (keys.filter((k) => !receiverOf(k)).length < 2) {
    tx = tx.addKey(generateKey().publicKey.toString(), { type: "fullAccess" });
    planted++;
  }
  console.log(planted ? `planted ${planted}, tx ${(await tx.send()).transaction.hash}` : "every problem is already there");
  const attackerKey = process.env.SEIN_TESTNET_ATTACKER_KEY;
  if (attackerKey && process.argv[2] === "contact") console.log("contact from the attacker, tx", (await near(attacker, attackerKey).transaction(attacker).transfer(account, "0.01 NEAR").send()).transaction.hash);
}
console.log(`scan it: https://sein-near.vercel.app/checkup?account=${account}&network=testnet`);
