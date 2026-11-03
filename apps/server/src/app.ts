import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AccessStore, AccountWatcher, Anchorer, buildPreflight, ChainApprovalVerifier, CustodyLogSource, FastNearTxSource, freezerFromEnv, loadEnv, Reconciler, registryFromEnv, RpcAccountStateReader, RpcNonceReader } from "@sealed-intent/core";
import { authFromEnv } from "./auth";

/** Secrets readable by another OS user defeat the separation between agent and checker. */
function checkSecretFile(path: string, offline: boolean): void {
  if (process.platform === "win32" || !existsSync(path)) return;
  if ((statSync(path).mode & 0o077) === 0) return;
  const message = `${path} is readable by other users; run: chmod 600 ${path}`;
  if (!offline) throw new Error(message);
  console.error(`Warning: ${message}`);
}

async function alertOwner(message: string, detail: unknown): Promise<void> {
  console.error(`ALERT: ${message} The wallet is frozen.`);
  const url = process.env.SEALED_ALERT_WEBHOOK;
  if (url) await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, detail }) }).catch(() => undefined);
}

/** Offline by default so anyone can run it. Set SEALED_MODE=live for mainnet. */
export function createApp() {
  loadEnv();
  const offline = (process.env.SEALED_MODE ?? "offline") !== "live";
  checkSecretFile(".env", offline);
  // the wallet is frozen here first, then on chain, so a dead chain call never leaves it open
  // an offline instance never touches the real custody wallet
  const custody = offline ? undefined : freezerFromEnv();
  const freezeBoth = async (reason: string, by: string, freezeHere: (reason: string, by: string) => void) => {
    freezeHere(reason, by);
    if (custody) await custody.freeze().catch((err: Error) => console.error(`on-chain freeze failed: ${err.message}`));
  };
  const wallet = process.env.OUTLAYER_NEAR_ACCOUNT;
  const testnet = process.env.SEALED_NETWORK === "testnet";
  let onMismatch: (message: string, detail: unknown) => Promise<void> = async () => undefined;
  const reconciler =
    !offline && wallet && process.env.OUTLAYER_API_KEY
      ? new Reconciler(join(".sealed", "reconcile.db"), {
          account: wallet,
          sources: [new FastNearTxSource(testnet ? "https://tx.test.fastnear.com" : "https://tx.main.fastnear.com"), new CustodyLogSource(process.env.OUTLAYER_BASE_URL ?? "https://api.outlayer.ai", process.env.OUTLAYER_API_KEY)],
          nonce: new RpcNonceReader(process.env.NEAR_RPC_URL ?? (testnet ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com")),
          onMismatch: (f) => onMismatch(`${f.account} signed ${f.unknownTx.length + f.uncountedByNonce} transaction(s) with no SeIn receipt.`, f),
        })
      : undefined;
  const env = buildPreflight({ offline, spendLog: reconciler });
  onMismatch = async (message, detail) => {
    await freezeBoth(`reconciliation: ${message}`, "reconciler", (r, by) => env.preflight.freeze(r, by));
    await alertOwner(message, detail);
  };
  const accounts = (process.env.SEALED_WATCH_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const watcher = accounts.length
    ? new AccountWatcher(join(".sealed", "watch.db"), {
        accounts,
        reader: new RpcAccountStateReader(),
        onChange: async (f) => {
          await freezeBoth(`account watcher: ${f.account} changed outside Sealed Intent`, "watcher", (r, by) => env.preflight.freeze(r, by));
          await alertOwner(`${f.account} changed outside SeIn (${f.newKeys.length} unknown key(s)${f.codeChanged ? ", code changed" : ""}).`, f);
        },
      })
    : undefined;
  const registry = !offline ? registryFromEnv() : undefined;
  const ownerAccount = process.env.SEALED_OWNER_ACCOUNT || undefined;
  return {
    ...env,
    offline,
    auth: authFromEnv(process.env, offline),
    watcher,
    reconciler,
    custody,
    access: new AccessStore(join(".sealed", "access.db")),
    ownerAccount,
    approvals: ownerAccount ? new ChainApprovalVerifier(testnet ? "testnet" : "mainnet", process.env.NEAR_RPC_URL ?? (testnet ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com")) : undefined,
    anchorer: registry ? new Anchorer(registry) : undefined,
    webOrigins: (process.env.SEALED_WEB_ORIGINS ?? "https://sein-near.vercel.app").split(",").map((s) => s.trim()).filter(Boolean),
    webUrl: process.env.SEALED_WEB_URL ?? "https://sein-near.vercel.app",
    publicUrl: process.env.SEALED_PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`,
    network: testnet ? "testnet" : "mainnet",
  };
}
