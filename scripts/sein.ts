#!/usr/bin/env tsx
/**
 * One command to run SeIn for your own agent.
 *
 *   pnpm sein setup              a few questions; writes your settings and your secret rules
 *   pnpm sein doctor             checks every piece and says what to fix
 *   pnpm sein start              runs SeIn on this computer; keep the window open
 *   pnpm sein connect <agent>    gives an agent access and writes its settings for Claude, Cursor, VS Code or plain HTTP
 *                                add --install claude-desktop to put it into Claude Desktop for you
 *   pnpm sein pending            payments waiting for you, each with a link to answer it with your wallet
 *   pnpm sein learn <lesson.json>  teach your agents a Checkpoint lesson: its accounts are blocked at once
 *   pnpm sein status | freeze [reason] | unfreeze
 *
 * Everything is kept in the folder my-sein (or --dir <folder>), never in the repository's own .env.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AccessStore, newPolicyKey, readSealedPolicy, writeSealedPolicy } from "@sealed-intent/core";
import { agentFiles, mcpServer, mergeEnv, OUTLAYER_CONTRACT, OUTLAYER_URL, policyFrom, readEnv, RPC_URL, TOKENS, type Network } from "../apps/server/src/setup";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const DIR = resolve(REPO, flag("--dir") ?? process.env.SEIN_DIR ?? "my-sein");
const install = flag("--install");
const [cmd, ...rest] = argv;
const ENV = join(DIR, ".env");
const ok = (s: string) => console.log(`  ok    ${s}`);
const bad = (s: string, fix: string) => console.log(`  FIX   ${s}\n        ${fix}`);
const note = (s: string) => console.log(`  note  ${s}`);

async function outlayer<T>(network: Network, key: string, path: string): Promise<{ status: number; body?: T }> {
  const res = await fetch(`${OUTLAYER_URL[network]}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: res.ok ? ((await res.json()) as T) : undefined };
}

async function accountExists(network: Network, account: string): Promise<boolean> {
  const res = await fetch(RPC_URL[network], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "sein", method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }), signal: AbortSignal.timeout(15_000) });
  return !!((await res.json()) as { result?: unknown }).result;
}

type CustodyPolicy = { policy?: unknown; frozen?: boolean };

/** The account that stored the custody policy, read from the OutLayer contract; only it can change or unfreeze the wallet. */
async function controllerOf(network: Network, wallet: string): Promise<string | undefined> {
  const args = Buffer.from(JSON.stringify({ wallet_pubkey: `ed25519:${wallet}` })).toString("base64");
  const res = await fetch(RPC_URL[network], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "sein", method: "query", params: { request_type: "call_function", finality: "final", account_id: OUTLAYER_CONTRACT[network], method_name: "get_wallet_policy", args_base64: args } }), signal: AbortSignal.timeout(15_000) });
  const r = ((await res.json()) as { result?: { result: number[] } }).result;
  const stored = r ? (JSON.parse(Buffer.from(r.result).toString()) as { owner?: string } | null) : null;
  return stored?.owner;
}

async function setup() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const old = existsSync(ENV) ? readEnv(readFileSync(ENV, "utf8")) : {};
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // a saved key is never printed back, only offered
  const ask = async (q: string, def = "", secret = false) => (await rl.question(def ? `${q} [${secret ? "keep saved key" : def}]: ` : `${q}: `)).trim() || def;

  console.log(`\nSeIn setup. Your answers stay on this computer, in ${DIR}.\nPress Enter to keep the value in [brackets].\n`);

  let network: Network;
  for (;;) {
    const n = (await ask("1. Network: testnet or mainnet", old.SEALED_NETWORK ?? "testnet")).toLowerCase();
    if (n === "testnet" || n === "mainnet") {
      network = n;
      break;
    }
  }
  // one folder, one wallet: its budget, history and agents must never carry over to another network
  const other = (why: string) => {
    rl.close();
    console.log(`
This folder already belongs to your ${old.SEALED_NETWORK} SeIn (${why}). Keep them apart, for example:
  pnpm sein setup --dir my-sein-${network}
and add the same --dir to every pnpm sein command for that one.
`);
  };
  if (old.SEALED_NETWORK && old.SEALED_NETWORK !== network) return other("another network");

  console.log(`\n2. Your custody wallet. Create one in the OutLayer dashboard (https://app.outlayer.ai, pick ${network}) and copy its API key.`);
  console.log("   Before you paste it here, set the wallet's policy in that dashboard with your own NEAR wallet, so you are its controller.");
  let key = "";
  let wallet = "";
  for (;;) {
    key = await ask("   API key (starts with wk_)", old.OUTLAYER_API_KEY && old.SEALED_NETWORK === network ? old.OUTLAYER_API_KEY : "", true);
    const a = await outlayer<{ address?: string; near_account_id?: string }>(network, key, "/wallet/v1/address?chain=near").catch(() => ({ status: 0, body: undefined }));
    wallet = a.body?.near_account_id ?? a.body?.address ?? "";
    if (wallet) break;
    console.log(`   OutLayer ${network} did not accept that key (HTTP ${a.status}). Copy the whole key, and check the network.`);
  }
  if (old.OUTLAYER_NEAR_ACCOUNT && old.OUTLAYER_NEAR_ACCOUNT !== wallet) return other("another custody wallet");
  console.log(`   Custody wallet: ${wallet}`);
  const controller = await controllerOf(network, wallet).catch(() => undefined);
  if (!controller) console.log("   WARNING: this wallet has no policy yet. Anyone holding the key could claim it. Set the policy in the OutLayer dashboard first.");
  else console.log(`   Its policy is controlled by ${controller}.`);

  let owner = "";
  for (;;) {
    owner = await ask(`\n3. Your own NEAR account. Only it can approve payments, with a wallet signature (e.g. you.${network === "testnet" ? "testnet" : "near"})`, old.SEALED_OWNER_ACCOUNT ?? controller ?? "");
    if (owner && (await accountExists(network, owner).catch(() => false))) break;
    console.log(`   ${owner || "That"} does not exist on ${network}.`);
  }

  console.log("\n4. Your rules. They stay secret: the agent never learns them.");
  const symbols = Object.keys(TOKENS[network]).join(", ");
  let tokens: string[] = [];
  for (;;) {
    tokens = (await ask(`   Tokens the agent may pay with (${symbols})`, "NEAR")).split(",").map((s) => s.trim()).filter(Boolean);
    if (tokens.length && tokens.every((t) => TOKENS[network][t.toUpperCase()])) break;
  }
  const num = async (q: string, def: string) => {
    for (;;) {
      const v = Number(await ask(q, def));
      if (v > 0) return v;
    }
  };
  const perPaymentUsd = await num("   Largest single payment, in US dollars", "5");
  const dailyUsd = await num("   Most it may spend in a day, in US dollars", "20");
  const receivers = (await ask("   Accounts it may pay without asking you, comma separated (Enter for none)", "")).split(",").map((s) => s.trim()).filter(Boolean);
  const newReceiver = (await ask("   Anyone else: ask you, or refuse? (ask/refuse)", "ask")).toLowerCase().startsWith("r") ? "block" : "warn";

  const nearAi = await ask("\n5. NEAR AI Cloud API key, for the check that spots a tricked agent (https://cloud.near.ai; Enter to skip)", old.NEARAI_API_KEY ?? "", true);
  rl.close();

  const policy = policyFrom({ network, owner, wallet, perPaymentUsd, dailyUsd, receivers, newReceiver, tokens, enclave: !!nearAi });
  const policyKey = old.SEALED_POLICY_KEY ?? newPolicyKey();
  mkdirSync(join(DIR, ".sealed"), { recursive: true, mode: 0o700 });
  writeSealedPolicy(join(DIR, ".sealed", "policy.sealed.json"), policy, policyKey);
  const values: Record<string, string> = {
    SEALED_MODE: "live",
    SEALED_NETWORK: network,
    OUTLAYER_BASE_URL: OUTLAYER_URL[network],
    OUTLAYER_API_KEY: key,
    OUTLAYER_NEAR_ACCOUNT: wallet,
    SEALED_OWNER_ACCOUNT: owner,
    SEALED_POLICY_KEY: policyKey,
    SEALED_OWNER_TOKEN: old.SEALED_OWNER_TOKEN ?? randomBytes(32).toString("hex"),
    NEARAI_BASE_URL: old.NEARAI_BASE_URL ?? "https://cloud-api.near.ai/v1",
    NEARAI_API_KEY: nearAi,
    NEARAI_MODEL: old.NEARAI_MODEL ?? "z-ai/glm-5.3-flash",
    NEAR_RPC_URL: RPC_URL[network],
    NEAR_RPC_URLS: RPC_URL[network],
    SEALED_WEB_URL: old.SEALED_WEB_URL ?? "https://sein-near.vercel.app",
    SEALED_WEB_ORIGINS: old.SEALED_WEB_ORIGINS ?? "https://sein-near.vercel.app",
    SEALED_PUBLIC_URL: old.SEALED_PUBLIC_URL ?? "http://127.0.0.1:8787",
  };
  writeFileSync(ENV, mergeEnv(existsSync(ENV) ? readFileSync(ENV, "utf8") : "# SeIn settings, written by pnpm sein setup. Keep this file private.\n", values));
  if (process.platform !== "win32") chmodSync(ENV, 0o600);

  console.log(`\nSaved. Up to $${perPaymentUsd} per payment and $${dailyUsd} a day, in ${tokens.join(", ")}. New receivers: ${newReceiver === "warn" ? "ask you" : "refused"}.`);
  if (!nearAi) console.log("Without a NEAR AI key the tricked-agent check runs on simple rules only.");
  console.log(`\nNext:\n  1. Send a little ${network === "testnet" ? "test " : ""}NEAR to the custody wallet ${wallet}\n  2. pnpm sein doctor        check everything\n  3. pnpm sein start         run SeIn and keep that window open\n  4. pnpm sein connect my-agent   in a second window, to connect your agent\n`);
}

async function doctor() {
  if (!existsSync(ENV)) return console.log(`No settings in ${DIR}. Run: pnpm sein setup`);
  const e = readEnv(readFileSync(ENV, "utf8"));
  const network: Network = e.SEALED_NETWORK === "testnet" ? "testnet" : "mainnet";
  console.log(`\nSeIn doctor, ${network}, settings in ${DIR}\n`);
  e.SEALED_MODE === "live" ? ok("live mode: real custody and real checks") : bad("not in live mode", "run pnpm sein setup again");

  const a = e.OUTLAYER_API_KEY ? await outlayer<{ address?: string; near_account_id?: string }>(network, e.OUTLAYER_API_KEY, "/wallet/v1/address?chain=near").catch(() => ({ status: 0, body: undefined })) : { status: 0, body: undefined };
  const wallet = a.body?.near_account_id ?? a.body?.address;
  if (!wallet) bad(`OutLayer did not accept the custody key (HTTP ${a.status})`, "copy the key again from the OutLayer dashboard and run pnpm sein setup");
  else if (wallet !== e.OUTLAYER_NEAR_ACCOUNT) bad(`the key belongs to ${wallet}, not ${e.OUTLAYER_NEAR_ACCOUNT}`, "run pnpm sein setup again");
  else ok(`custody wallet ${wallet}`);

  if (wallet) {
    const p = await outlayer<CustodyPolicy>(network, e.OUTLAYER_API_KEY!, "/wallet/v1/policy").catch(() => ({ status: 0, body: undefined }));
    const controller = await controllerOf(network, wallet).catch(() => undefined);
    if (!controller) bad("the custody wallet has no policy, so anyone with the key could claim it", "set a policy in the OutLayer dashboard with your own NEAR wallet");
    else if (controller !== e.SEALED_OWNER_ACCOUNT) bad(`the custody policy is controlled by ${controller}, not by you (${e.SEALED_OWNER_ACCOUNT})`, "check who set the policy in the OutLayer dashboard");
    else ok(`custody policy stored on chain and controlled by you, ${controller}`);
    if (p.body?.frozen) bad("the custody wallet is frozen", "unfreeze it in the OutLayer dashboard when you are sure why it froze");
    const b = await outlayer<{ balance?: string }>(network, e.OUTLAYER_API_KEY!, "/wallet/v1/balance?chain=near").catch(() => ({ status: 0, body: undefined }));
    const near = b.body?.balance ? Number(BigInt(b.body.balance) / 10n ** 21n) / 1000 : 0;
    near > 0 ? ok(`custody balance ${near} NEAR`) : bad("the custody wallet holds no NEAR", `send a little NEAR to ${wallet}`);
  }

  const owner = e.SEALED_OWNER_ACCOUNT;
  owner && (await accountExists(network, owner).catch(() => false)) ? ok(`owner ${owner}: approvals need this account's wallet signature`) : bad(`owner account ${owner ?? "(none)"} not found on ${network}`, "run pnpm sein setup again");

  try {
    const p = readSealedPolicy(join(DIR, ".sealed", "policy.sealed.json"), e.SEALED_POLICY_KEY ?? "");
    ok(`secret rules: up to $${p.perTxUsd} per payment, $${p.dailyUsd} a day, ${p.allowedRecipients.length} known receiver(s), others ${p.unknownRecipient === "warn" ? "ask you" : "refused"}`);
  } catch {
    bad("the secret rules cannot be read", "run pnpm sein setup again");
  }

  if (!e.NEARAI_API_KEY) note("no NEAR AI key: the tricked-agent check uses simple rules only");
  else {
    const r = await fetch(`${e.NEARAI_BASE_URL ?? "https://cloud-api.near.ai/v1"}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${e.NEARAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: e.NEARAI_MODEL, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }), signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
    r?.ok ? ok(`NEAR AI Cloud key works (${e.NEARAI_MODEL})`) : bad(`NEAR AI Cloud refused the key (HTTP ${r?.status ?? "no answer"})`, "create a key at https://cloud.near.ai and run pnpm sein setup again");
  }

  const s = await fetch(`${e.SEALED_PUBLIC_URL ?? "http://127.0.0.1:8787"}/v1/status`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json() as Promise<{ frozen: boolean; mode: string }>).catch(() => undefined);
  if (!s) note("SeIn is not running. Start it with: pnpm sein start");
  else s.frozen ? bad("SeIn is running but frozen: every payment is refused", "see why with pnpm sein status, then pnpm sein unfreeze") : ok(`SeIn is running (${s.mode})`);
  const agents = existsSync(join(DIR, "agents")) ? readdirSync(join(DIR, "agents")) : [];
  agents.length ? ok(`agents connected: ${agents.join(", ")}`) : note("no agent connected yet. Connect one with: pnpm sein connect my-agent");
  console.log("");
}

function claudeDesktopConfig(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function connect(name: string | undefined) {
  if (!name || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return console.log("Give the agent a short name in lowercase letters, digits and dashes, e.g.: pnpm sein connect shop-bot");
  if (!existsSync(ENV)) return console.log(`No settings in ${DIR}. Run: pnpm sein setup`);
  const e = readEnv(readFileSync(ENV, "utf8"));
  const network: Network = e.SEALED_NETWORK === "testnet" ? "testnet" : "mainnet";
  // the agent signs every request with its own key, so a stolen token alone is useless
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicHex = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
  const seedHex = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32).toString("hex");
  mkdirSync(join(DIR, ".sealed"), { recursive: true, mode: 0o700 });
  const token = new AccessStore(join(DIR, ".sealed", "access.db")).issue(name, publicHex);
  const access = { name, restUrl: e.SEALED_PUBLIC_URL ?? "http://127.0.0.1:8787", token, signingKey: seedHex, network, node: process.execPath, tsx: join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), bridge: join(REPO, "apps", "server", "src", "mcp-agent.ts") };
  const out = join(DIR, "agents", name);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const [file, text] of Object.entries(agentFiles(access))) writeFileSync(join(out, file), text, { mode: 0o600 });

  console.log(`\n${name} can now ask SeIn to pay. It holds no wallet key and cannot see your rules.`);
  console.log(`Its settings are in ${out}. Pick how your agent runs:\n`);
  console.log(`  Claude Desktop   pnpm sein connect ${name} --install claude-desktop   (or paste mcp.json into Settings, Developer, Edit Config)`);
  console.log(`  Claude Code      run the command in claude-code.txt`);
  console.log(`  Cursor           paste mcp.json into Cursor's MCP settings`);
  console.log(`  VS Code          use vscode-mcp.json as .vscode/mcp.json`);
  console.log(`  Your own code    load agent.env and call the REST API; see examples/rest-agent.mjs\n`);
  console.log(`Then ask the agent something like: "Pay 0.01 NEAR to ${e.SEALED_OWNER_ACCOUNT ?? "bob.near"} for the October invoice."`);
  console.log("Keep pnpm sein start running in another window. Payments that need you show up there with a link.\n");

  if (install === "claude-desktop") {
    const path = claudeDesktopConfig();
    const config = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, unknown> }) : {};
    if (existsSync(path)) copyFileSync(path, `${path}.before-sein`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...config, mcpServers: { ...(config.mcpServers ?? {}), sein: mcpServer(access) } }, null, 2) + "\n");
    console.log(`Added to Claude Desktop (${path}). Restart Claude Desktop, then look for the SeIn tools.\n`);
  }
}

/** A lesson downloaded from the Checkpoint goes to the running SeIn, which blocks its accounts and shows its rules to agents. */
async function learn(file: string | undefined) {
  if (!file || !existsSync(file)) return console.log("Give the lesson file downloaded from the Checkpoint, e.g.: pnpm sein learn sein-lesson-you.near.json");
  if (!existsSync(ENV)) return console.log(`No settings in ${DIR}. Run: pnpm sein setup`);
  const e = readEnv(readFileSync(ENV, "utf8"));
  const lesson = JSON.parse(readFileSync(file, "utf8")) as { neverPay?: { account: string }[]; rules?: string[] };
  const res = await fetch(`${e.SEALED_PUBLIC_URL ?? "http://127.0.0.1:8787"}/v1/lessons`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${e.SEALED_OWNER_TOKEN}` }, body: JSON.stringify(lesson) }).catch(() => undefined);
  if (!res) return console.log("SeIn is not running. Start it with pnpm sein start, then try again.");
  const out = (await res.json()) as { blocked?: number; rules?: number; error?: string };
  if (!res.ok) return console.log(`SeIn refused it: ${out.error}`);
  console.log(`Learned. ${out.blocked} account(s) are now blocked for every agent, and agents see ${out.rules} rule(s) with their lessons tool.`);
}

async function start() {
  if (!existsSync(ENV)) return console.log(`No settings in ${DIR}. Run: pnpm sein setup`);
  process.chdir(DIR);
  const e = readEnv(readFileSync(".env", "utf8"));
  console.log(`\nSeIn on ${e.SEALED_NETWORK}. Custody wallet ${e.OUTLAYER_NEAR_ACCOUNT}, owner ${e.SEALED_OWNER_ACCOUNT}.`);
  console.log("Keep this window open. Payments that need you appear here with a link. Stop with Ctrl+C.\n");
  const { startGateway } = await import("../apps/server/src/gateway");
  startGateway();
}

async function owner() {
  if (!existsSync(ENV)) return console.log(`No settings in ${DIR}. Run: pnpm sein setup`);
  process.chdir(DIR);
  process.argv = [process.argv[0]!, process.argv[1]!, cmd!, ...rest];
  await import("./owner");
}

switch (cmd) {
  case "setup":
    await setup();
    break;
  case "doctor":
    await doctor();
    break;
  case "start":
    await start();
    break;
  case "connect":
    connect(rest[0]);
    break;
  case "learn":
    await learn(rest[0]);
    break;
  case "pending":
  case "status":
  case "freeze":
  case "unfreeze":
    await owner();
    break;
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]!.replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, ""));
}
