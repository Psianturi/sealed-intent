#!/usr/bin/env tsx
/**
 * The public registry on testnet.
 *   pnpm registry deploy                    create the accounts from the faucet, deploy, record the issuer key
 *   pnpm registry register                  the test owner registers one agent for the custody wallet
 *   pnpm registry anchor [outDir]           anchor receipts not yet anchored, write proofs
 *   pnpm registry set-policy                record a salted commitment to SeIn's policy for agent-1
 *   pnpm registry status                    what the contract holds
 *   pnpm registry hosted-key                give the hosted SeIn its own receipt key (kept in .env) and list it
 *   pnpm registry upgrade                   deploy the committed wasm over the live one; the state stays
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKey, Near } from "near-kit";
import { Anchorer, registryFromEnv } from "@sealed-intent/core";
import { commit, loadEnv, loadOrCreateIssuerKey } from "@sealed-intent/receipt";
import { testnetPolicy } from "./testnet-policy";

loadEnv();
const RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
if (process.env.SEALED_NETWORK !== "testnet") throw new Error("testnet only for now: mainnet is the owner's decision");
const env = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is missing from .env`);
  return v;
};
const near = (account: string, key: string) => new Near({ network: { networkId: "testnet", rpcUrl: RPC }, privateKey: key as `ed25519:${string}`, defaultSignerId: account });
const HOME = join(".sealed", "testnet");
const issuerHex = () => loadOrCreateIssuerKey(join(HOME, "issuer.pem")).publicKeyHex;

async function faucet(role: string, suffix: string): Promise<{ account: string; key: string }> {
  const account = `sein-${role}-${suffix}.testnet`;
  const key = generateKey();
  const res = await fetch("https://helper.testnet.near.org/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ newAccountId: account, newAccountPublicKey: key.publicKey.toString() }) });
  if (!res.ok) throw new Error(`faucet ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { account, key: key.secretKey };
}

async function deploy() {
  if (process.env.SEIN_REGISTRY_ACCOUNT) {
    console.log("already deployed:", process.env.SEIN_REGISTRY_ACCOUNT);
    return;
  }
  const suffix = Date.now().toString(36);
  const registry = await faucet("registry", suffix);
  const operator = await faucet("operator", suffix);
  appendFileSync(".env", `SEIN_REGISTRY_ACCOUNT=${registry.account}\nSEIN_REGISTRY_KEY=${registry.key}\nSEIN_OPERATOR_ACCOUNT=${operator.account}\nSEIN_OPERATOR_KEY=${operator.key}\n`);
  // the faucet account needs a moment to be visible
  await new Promise((d) => setTimeout(d, 4000));
  const wasm = new Uint8Array(readFileSync(join("contracts", "sein-registry", "sein_registry.wasm")));
  const tx = await near(registry.account, registry.key).transaction(registry.account).deployContract(registry.account, wasm).functionCall(registry.account, "new", { operator: operator.account }, { gas: "100 Tgas" }).send();
  await near(operator.account, operator.key).transaction(operator.account).functionCall(registry.account, "add_issuer_key", { public_key: issuerHex() }, { gas: "30 Tgas" }).send();
  console.log("deployed", registry.account, "tx", tx.transaction.hash, "wasm sha256", createHash("sha256").update(wasm).digest("hex"));
}

async function upgrade() {
  const account = env("SEIN_REGISTRY_ACCOUNT");
  const wasm = new Uint8Array(readFileSync(join("contracts", "sein-registry", "sein_registry.wasm")));
  const tx = await near(account, env("SEIN_REGISTRY_KEY")).transaction(account).deployContract(account, wasm).send();
  console.log("upgraded", account, "tx", tx.transaction.hash, "wasm sha256", createHash("sha256").update(wasm).digest("hex"));
}

async function register() {
  const owner = env("SEIN_TESTNET_OWNER_ACCOUNT");
  const contract = env("SEIN_REGISTRY_ACCOUNT");
  const policyHash = commit(testnetPolicy(env("OUTLAYER_NEAR_ACCOUNT"), env("SEIN_TESTNET_VENDOR_ACCOUNT"))).commitment;
  const agentKeyFile = join(HOME, "agent-signing.key");
  let agentPublic: string;
  if (existsSync(agentKeyFile)) agentPublic = readFileSync(agentKeyFile, "utf8").split("\n")[0]!.trim();
  else {
    const key = generateKey();
    agentPublic = Buffer.from(key.publicKey.data).toString("hex");
    writeFileSync(agentKeyFile, `${agentPublic}\n${key.secretKey}\n`, { mode: 0o600 });
  }
  const tx = await near(owner, env("SEIN_TESTNET_OWNER_KEY")).transaction(owner).functionCall(contract, "register_agent", { custody_account: env("OUTLAYER_NEAR_ACCOUNT"), policy_hash: policyHash, agent_key: agentPublic }, { gas: "50 Tgas", attachedDeposit: "0.1 NEAR" }).send();
  const list = await registryFromEnv()!.view<string[]>("agents_of", { owner });
  console.log("registered", list.at(-1), "tx", tx.transaction.hash);
}

async function status() {
  const r = registryFromEnv()!;
  console.log(JSON.stringify({ contract: r.contract, operator: await r.view("operator"), issuers: await r.view("issuer_keys"), agents: await r.view("agent_count"), agent1: await r.view("get_agent", { agent_id: "agent-1" }), anchors: await r.view("anchor_count"), latest: await r.latestAnchor() }, null, 2));
}

/** A plain hash of a small policy could be guessed, so the registry holds a salted commitment. The opening stays private. */
async function setPolicy() {
  const owner = env("SEIN_TESTNET_OWNER_ACCOUNT");
  const { commitment, opening } = commit(testnetPolicy(env("OUTLAYER_NEAR_ACCOUNT"), env("SEIN_TESTNET_VENDOR_ACCOUNT")));
  writeFileSync(join(HOME, "policy-opening.json"), JSON.stringify(opening), { mode: 0o600 });
  const tx = await near(owner, env("SEIN_TESTNET_OWNER_KEY")).transaction(owner).functionCall(env("SEIN_REGISTRY_ACCOUNT"), "set_policy_hash", { agent_id: "agent-1", policy_hash: commitment }, { gas: "30 Tgas" }).send();
  console.log("policy commitment recorded, tx", tx.transaction.hash);
}

/** The hosted SeIn signs with its own key, so its receipts also pass the "key is on the registry" check. */
async function hostedKey() {
  const { createPrivateKey, createPublicKey, generateKeyPairSync } = await import("node:crypto");
  // .env holds one line per value, so the PEM's line breaks are kept as \n
  let pem = process.env.SEIN_HOSTED_ISSUER_PEM?.replace(/\\n/g, "\n");
  if (!pem) {
    pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    appendFileSync(".env", `SEIN_HOSTED_ISSUER_PEM=${pem.trim().replace(/\n/g, "\\n")}\n`);
  }
  const hex = (createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
  const listed = await new Near({ network: { networkId: "testnet", rpcUrl: RPC } }).view(env("SEIN_REGISTRY_ACCOUNT"), "issuer_key", { public_key: hex });
  if (listed) return console.log("hosted receipt key already listed:", hex);
  const tx = await near(env("SEIN_OPERATOR_ACCOUNT"), env("SEIN_OPERATOR_KEY")).transaction(env("SEIN_OPERATOR_ACCOUNT")).functionCall(env("SEIN_REGISTRY_ACCOUNT"), "add_issuer_key", { public_key: hex }, { gas: "30 Tgas" }).send();
  console.log("hosted receipt key", hex, "listed, tx", tx.transaction.hash);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "deploy") await deploy();
else if (cmd === "upgrade") await upgrade();
else if (cmd === "hosted-key") await hostedKey();
else if (cmd === "register") await register();
else if (cmd === "set-policy") await setPolicy();
else if (cmd === "status") await status();
else if (cmd === "anchor") console.log(JSON.stringify(await new Anchorer(registryFromEnv()!, arg ?? join("out", "testnet")).tick()));
else console.log("usage: pnpm registry deploy | register | anchor [outDir] | status");
process.exit(0);
