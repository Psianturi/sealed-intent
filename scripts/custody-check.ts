#!/usr/bin/env tsx
/**
 * S3: does OutLayer refuse what the policy forbids when the request does not go through SeIn?
 * Every attempt uses the wallet API key directly. Testnet, test tokens only.
 *   pnpm custody:check             policy with the token contract on the list
 *   pnpm custody:check --hardened  policy without any contract call
 *   pnpm custody:check --token-lane  policy shaped like the mainnet swap: one token contract, tiny native limits
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { generateKey, Near } from "near-kit";
import { loadEnv } from "@sealed-intent/receipt";

loadEnv();
const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is missing from .env`);
  return v;
};
const RPC = need("NEAR_RPC_URL");
const BASE = need("OUTLAYER_BASE_URL");
if (!BASE.includes("testnet")) throw new Error("testnet only");
const KEY = need("OUTLAYER_API_KEY");
const WALLET = need("OUTLAYER_NEAR_ACCOUNT");
const VENDOR = need("SEIN_TESTNET_VENDOR_ACCOUNT");
const ATTACKER = need("SEIN_TESTNET_ATTACKER_ACCOUNT");
const OWNER = need("SEIN_TESTNET_OWNER_ACCOUNT");
const WRAP = "wrap.testnet";
const CONTROL = "outlayer.testnet";
const yocto = (n: number) => (BigInt(Math.round(n * 100000)) * 10n ** 19n).toString();
const near = (signer: string, key: string) => new Near({ network: { networkId: "testnet", rpcUrl: RPC }, privateKey: key as `ed25519:${string}`, defaultSignerId: signer });
const reader = near(OWNER, need("SEIN_TESTNET_OWNER_KEY"));
const sleep = (ms: number) => new Promise((d) => setTimeout(d, ms));

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { http: res.status, ...json };
}

const balances = async () => {
  const of = async (a: string) => ({ native: await reader.getBalance(a).then(String).catch(() => "0"), wrap: await reader.view<string>(WRAP, "ft_balance_of", { account_id: a }).catch(() => "0") });
  return { attacker: await of(ATTACKER), wallet: await of(WALLET) };
};
const toYocto = (s: string) => (/^\d+$/.test(s) ? BigInt(s) : BigInt(Math.round(parseFloat(s) * 100000)) * 10n ** 19n);

type Row = { name: string; expect: "allowed" | "refused"; http?: number; error?: unknown; message?: unknown; txHash?: unknown; status?: unknown; outcome: "allowed" | "refused"; asExpected: boolean; attackerWrapDelta: string; attackerNativeDelta: string };
const rows: Row[] = [];
async function attempt(name: string, expect: Row["expect"], run: () => Promise<Record<string, unknown>>) {
  const before = await balances();
  let r: Record<string, unknown>;
  try {
    r = await run();
  } catch (e) {
    r = { error: "chain_refused", message: String((e as Error).message).slice(0, 240) };
  }
  await sleep(2500);
  const after = await balances();
  // a 422 means custody signed it and the chain then failed it: the policy did not refuse
  const signedAnyway = r.error === "onchain_tx_failed";
  const outcome: Row["outcome"] = !signedAnyway && (r.error || (typeof r.http === "number" && r.http >= 400) || r.status === "failed") ? "refused" : "allowed";
  const row: Row = {
    name,
    expect,
    http: r.http as number | undefined,
    error: r.error,
    message: typeof r.message === "string" ? r.message.slice(0, 220) : r.message,
    txHash: r.tx_hash,
    status: r.status,
    outcome,
    asExpected: outcome === expect,
    attackerWrapDelta: (BigInt(after.attacker.wrap ?? "0") - BigInt(before.attacker.wrap ?? "0")).toString(),
    attackerNativeDelta: (toYocto(after.attacker.native) - toYocto(before.attacker.native)).toString(),
  };
  rows.push(row);
  console.log(`${row.asExpected ? "ok " : "!! "} ${name} -> ${outcome} http=${row.http ?? "-"} ${row.error ?? ""} ${typeof row.message === "string" ? row.message.slice(0, 110) : ""} tx=${row.txHash ?? "-"} wrapToAttacker=${row.attackerWrapDelta}`);
}
const call = (receiver_id: string, method_name: string, args: unknown, deposit: string, gas = "30000000000000") => api("/wallet/v1/call", { receiver_id, method_name, args, deposit, gas });
const send = (to: string, amount: string) => api("/wallet/v1/transfer", { chain: "near", to, amount });

// both test recipients hold wNEAR storage, so a refusal below is never a storage error
for (const [acc, key] of [
  [VENDOR, need("SEIN_TESTNET_VENDOR_KEY")],
  [ATTACKER, need("SEIN_TESTNET_ATTACKER_KEY")],
] as const) {
  if ((await reader.view(WRAP, "storage_balance_of", { account_id: acc })) === null) await near(acc, key).transaction(acc).functionCall(WRAP, "storage_deposit", { registration_only: true }, { gas: "30 Tgas", attachedDeposit: "0.00125 NEAR" }).send();
}

if (process.argv.includes("--token-lane")) {
  await attempt("wNEAR to the vendor through the listed token contract", "allowed", () => call(WRAP, "ft_transfer", { receiver_id: VENDOR, amount: yocto(0.001) }, "1"));
  await attempt("wNEAR to the attacker through the listed token contract", "refused", () => call(WRAP, "ft_transfer", { receiver_id: ATTACKER, amount: yocto(0.001) }, "1"));
  await attempt("attach more NEAR than the limit to the token contract", "refused", () => call(WRAP, "near_deposit", {}, yocto(0.1)));
  await attempt("native NEAR to the vendor", "refused", () => send(VENDOR, yocto(0.001)));
  await attempt("native NEAR to the attacker", "refused", () => send(ATTACKER, yocto(0.001)));
  await attempt("call a contract that is not on the list", "refused", () => call("guest-book.testnet", "add_message", { text: "x" }, "0"));
  await attempt("sign a NEP-413 message", "refused", () => api("/wallet/v1/sign-message", { message: "login", recipient: "evil.testnet" }));
  await attempt("delete the wallet and sweep to the attacker", "refused", () => api("/wallet/v1/delete", { beneficiary: ATTACKER }));
  const passedT = rows.filter((r) => r.asExpected).length;
  writeFileSync("evidence/custody-testnet/s3-token-lane.json", JSON.stringify({ ranAt: new Date().toISOString(), network: "testnet", wallet: WALLET, passed: passedT, total: rows.length, rows }, null, 2) + "\n");
  console.log(`${passedT} of ${rows.length} as expected.`);
  process.exit(0);
}

const hardened = process.argv.includes("--hardened");
if (hardened) {
  await attempt("native NEAR to the allowed vendor", "allowed", () => send(VENDOR, yocto(0.001)));
  await attempt("native NEAR to the attacker", "refused", () => send(ATTACKER, yocto(0.001)));
  await attempt("native NEAR above the per-transaction limit", "refused", () => send(VENDOR, yocto(0.6)));
  await attempt("wNEAR to the attacker", "refused", () => call(WRAP, "ft_transfer", { receiver_id: ATTACKER, amount: yocto(0.001) }, "1"));
  await attempt("wNEAR to the vendor", "refused", () => call(WRAP, "ft_transfer", { receiver_id: VENDOR, amount: yocto(0.001) }, "1"));
  await attempt("wNEAR to the attacker with ft_transfer_call", "refused", () => call(WRAP, "ft_transfer_call", { receiver_id: ATTACKER, amount: yocto(0.001), msg: "" }, "1", "100000000000000"));
  await attempt("sign a NEP-413 message", "refused", () => api("/wallet/v1/sign-message", { message: "login", recipient: "evil.testnet" }));
  await attempt("delete the wallet and sweep to the attacker", "refused", () => api("/wallet/v1/delete", { beneficiary: ATTACKER }));
  const passedH = rows.filter((r) => r.asExpected).length;
  writeFileSync("evidence/custody-testnet/s3-hardened.json", JSON.stringify({ ranAt: new Date().toISOString(), network: "testnet", wallet: WALLET, passed: passedH, total: rows.length, rows }, null, 2) + "\n");
  console.log(`${passedH} of ${rows.length} as expected.`);
  process.exit(0);
}

const wrapped = BigInt((await reader.view<string>(WRAP, "ft_balance_of", { account_id: WALLET }).catch(() => "0")) ?? "0");
if (wrapped < BigInt(yocto(0.7))) await attempt("wrap 0.5 NEAR on the allowed contract", "allowed", () => call(WRAP, "near_deposit", {}, yocto(0.5)));
await attempt("native NEAR to the allowed vendor", "allowed", () => send(VENDOR, yocto(0.01)));
await attempt("native NEAR to the attacker", "refused", () => send(ATTACKER, yocto(0.01)));
await attempt("native NEAR above the per-transaction limit", "refused", () => send(VENDOR, yocto(1.1)));
await attempt("wNEAR to the allowed vendor", "allowed", () => call(WRAP, "ft_transfer", { receiver_id: VENDOR, amount: yocto(0.01) }, "1"));
await attempt("wNEAR to the attacker through the allowed token contract", "refused", () => call(WRAP, "ft_transfer", { receiver_id: ATTACKER, amount: yocto(0.001) }, "1"));
await attempt("wNEAR above the token limit to the vendor", "refused", () => call(WRAP, "ft_transfer", { receiver_id: VENDOR, amount: yocto(0.6) }, "1"));
await attempt("wNEAR to the attacker with ft_transfer_call", "refused", () => call(WRAP, "ft_transfer_call", { receiver_id: ATTACKER, amount: yocto(0.001), msg: "" }, "1", "100000000000000"));
await attempt("call a contract that is not on the list", "refused", () => call("guest-book.testnet", "add_message", { text: "x" }, "0"));
await attempt("sign a NEP-413 message", "refused", () => api("/wallet/v1/sign-message", { message: "login", recipient: "evil.testnet" }));
await attempt("delete the wallet and sweep to the attacker", "refused", () => api("/wallet/v1/delete", { beneficiary: ATTACKER }));
await attempt("intents withdraw to the attacker", "refused", () => api("/wallet/v1/intents/withdraw", { to: ATTACKER, amount: yocto(0.001), token: `nep141:${WRAP}`, chain: "near" }));

// the policy itself: the API key can produce a signature, but the contract only takes it from the controller
const attackerChain = near(ATTACKER, need("SEIN_TESTNET_ATTACKER_KEY"));
const emptied = await api("/wallet/v1/encrypt-policy", { wallet_id: need("OUTLAYER_WALLET_ID"), rules: {} });
const signed = await api("/wallet/v1/sign-policy", { encrypted_data: emptied.encrypted_base64, caller: ATTACKER });
console.log("key holder can encrypt:", emptied.http, "and sign:", signed.http);
await attempt("key holder plus another account replaces the policy", "refused", async () => {
  await attackerChain.transaction(ATTACKER).functionCall(CONTROL, "store_wallet_policy", { wallet_pubkey: `ed25519:${WALLET}`, encrypted_data: emptied.encrypted_base64, wallet_signature: signed.signature_hex }, { gas: "100 Tgas", attachedDeposit: "0.2 NEAR" }).send();
  return { status: "stored" };
});
await attempt("the wallet replaces its own policy through a call", "refused", async () => {
  const s = await api("/wallet/v1/sign-policy", { encrypted_data: emptied.encrypted_base64, caller: WALLET });
  return call(CONTROL, "store_wallet_policy", { wallet_pubkey: `ed25519:${WALLET}`, encrypted_data: emptied.encrypted_base64, wallet_signature: s.signature_hex }, yocto(0.2));
});
await attempt("another account deletes the policy", "refused", async () => {
  await attackerChain.transaction(ATTACKER).functionCall(CONTROL, "delete_wallet_policy", { wallet_pubkey: `ed25519:${WALLET}` }, { gas: "50 Tgas" }).send();
  return { status: "deleted" };
});

// freeze with a key that can do nothing else
const owner = near(OWNER, need("SEIN_TESTNET_OWNER_KEY"));
const freezeKey = generateKey();
await owner.transaction(OWNER).addKey(freezeKey.publicKey.toString(), { type: "functionCall", receiverId: CONTROL, methodNames: ["freeze_wallet"], allowance: "0.25 NEAR" }).send();
const freezer = near(OWNER, freezeKey.secretKey);
await attempt("a freeze-only key freezes the wallet", "allowed", async () => {
  const tx = await freezer.transaction(OWNER).functionCall(CONTROL, "freeze_wallet", { wallet_pubkey: `ed25519:${WALLET}` }, { gas: "50 Tgas" }).send();
  return { status: "frozen", tx_hash: tx.transaction.hash };
});
await sleep(4000);
await attempt("frozen wallet: a payment that was allowed", "refused", () => send(VENDOR, yocto(0.001)));
await attempt("the freeze-only key cannot unfreeze", "refused", async () => {
  await freezer.transaction(OWNER).functionCall(CONTROL, "unfreeze_wallet", { wallet_pubkey: `ed25519:${WALLET}` }, { gas: "50 Tgas" }).send();
  return { status: "unfrozen" };
});
await attempt("another account unfreezes", "refused", async () => {
  await attackerChain.transaction(ATTACKER).functionCall(CONTROL, "unfreeze_wallet", { wallet_pubkey: `ed25519:${WALLET}` }, { gas: "50 Tgas" }).send();
  return { status: "unfrozen" };
});
await attempt("the controller unfreezes", "allowed", async () => {
  const tx = await owner.transaction(OWNER).functionCall(CONTROL, "unfreeze_wallet", { wallet_pubkey: `ed25519:${WALLET}` }, { gas: "50 Tgas" }).send();
  return { status: "unfrozen", tx_hash: tx.transaction.hash };
});
await sleep(4000);
await attempt("after unfreeze the allowed payment works again", "allowed", () => send(VENDOR, yocto(0.001)));
await owner.transaction(OWNER).deleteKey(OWNER, freezeKey.publicKey.toString()).send().catch((e) => console.log("freeze key not removed:", String(e).slice(0, 120)));

const passed = rows.filter((r) => r.asExpected).length;
const wrapLeak = rows.reduce((n, r) => n + BigInt(r.attackerWrapDelta), 0n);
const out = { ranAt: new Date().toISOString(), network: "testnet", wallet: WALLET, vendor: VENDOR, attacker: ATTACKER, controller: OWNER, passed, total: rows.length, wNearMovedToAttackerYocto: wrapLeak.toString(), rows };
mkdirSync("evidence/custody-testnet", { recursive: true });
writeFileSync("evidence/custody-testnet/s3-direct-attempts.json", JSON.stringify(out, null, 2) + "\n");
console.log(`\n${passed} of ${rows.length} as expected. wNEAR moved to the attacker: ${wrapLeak} yocto.`);
