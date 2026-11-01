import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AccountWatcher, buildPreflight, loadEnv, RpcAccountStateReader, type WatchFinding } from "@sealed-intent/core";
import { authFromEnv } from "./auth";

/** Secrets readable by another OS user defeat the separation between agent and checker. */
function checkSecretFile(path: string, offline: boolean): void {
  if (process.platform === "win32" || !existsSync(path)) return;
  if ((statSync(path).mode & 0o077) === 0) return;
  const message = `${path} is readable by other users; run: chmod 600 ${path}`;
  if (!offline) throw new Error(message);
  console.error(`Warning: ${message}`);
}

async function alertOwner(f: WatchFinding): Promise<void> {
  console.error(`ALERT: ${f.account} changed outside Sealed Intent (${f.newKeys.length} unknown key(s)${f.codeChanged ? ", code changed" : ""}). The wallet is frozen.`);
  const url = process.env.SEALED_ALERT_WEBHOOK;
  if (url) await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }).catch(() => undefined);
}

/** Offline by default so anyone can run it. Set SEALED_MODE=live for mainnet. */
export function createApp() {
  loadEnv();
  const offline = (process.env.SEALED_MODE ?? "offline") !== "live";
  checkSecretFile(".env", offline);
  const env = buildPreflight({ offline });
  const accounts = (process.env.SEALED_WATCH_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const watcher = accounts.length
    ? new AccountWatcher(join(".sealed", "watch.db"), {
        accounts,
        reader: new RpcAccountStateReader(),
        onChange: async (f) => {
          env.preflight.freeze(`account watcher: ${f.account} changed outside Sealed Intent`, "watcher");
          await alertOwner(f);
        },
      })
    : undefined;
  return { ...env, offline, auth: authFromEnv(process.env, offline), watcher };
}
