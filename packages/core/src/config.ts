import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, loadOrCreateIssuerKey, loadVault, type Vault } from "@sealed-intent/receipt";
import { BudgetLedger } from "./budget";
import { CounterpartyMemory, FixtureChainReader, RpcChainReader, SharedBlocklist, type ChainReader } from "./counterparty";
import { OutLayerExecutor, SimulatedExecutor, type Executor } from "./executor";
import {
  DEMO_POLICY,
  FIXTURE_BLOCKLIST,
  FIXTURE_CHAIN,
  FIXTURE_MANAGER_PUBLIC_KEY,
  FIXTURE_PREVIOUS_CODE_HASH,
  FixtureOneClickClient,
} from "./fixtures";
import { HttpOneClickClient } from "./oneclick";
import { PendingStore } from "./pending";
import { FreezeStore } from "./freeze";
import { readSealedPolicy, type Policy } from "./policy";
import { Preflight } from "./preflight";
import { ReceiptStore } from "./store";
import { NearAiCloudChecker, SimulatedTeeChecker, type TeeChecker } from "./tee-check";

export interface BuildOptions {
  offline: boolean;
  home?: string; // where .sealed lives
  outDir?: string;
  policy?: Policy;
  ledgerPath?: string;
  /** replace the enclave checker */
  tee?: TeeChecker;
  /** test hook: replace the executor */
  executor?: Executor;
  /** test hook: replace the chain reader used for counterparty signals */
  chain?: ChainReader;
  /** test hook: replace the 1Click client (offline only) */
  oneclick?: FixtureOneClickClient;
}

/**
 * Wire everything up.
 *  offline: fixture 1Click (signed with a fixture manager key), simulated TEE, simulated executor
 *  live:    real 1Click, NEAR AI Cloud (if NEARAI_API_KEY set), OutLayer custody (if OUTLAYER_API_KEY set)
 */
export interface Built {
  preflight: Preflight;
  ledger: BudgetLedger;
  pending: PendingStore;
  freeze: FreezeStore;
  oneclick: FixtureOneClickClient | HttpOneClickClient;
  blocklist: SharedBlocklist;
  memory: CounterpartyMemory;
  store: ReceiptStore;
  vault: Vault;
}

/** Reads .env from the working directory when present. Values already in the environment win. */
export { loadEnv };

export function buildPreflight(opts: BuildOptions): Built {
  loadEnv();
  const home = opts.home ?? ".sealed";
  // the keys and databases live here; no other OS user may even list it
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const issuer = loadOrCreateIssuerKey(join(home, "issuer.pem"));
  const vault = loadVault(home, { requireEnvKey: !opts.offline });
  const blind = (s: string) => vault.blind(s);
  const store = new ReceiptStore(opts.outDir ?? "out", home, vault);
  const ledgerPath = opts.ledgerPath ?? join(home, "budget.db");
  const ledger = new BudgetLedger(ledgerPath, undefined, blind);
  const pending = new PendingStore(ledgerPath, vault);
  const freeze = new FreezeStore(ledgerPath, vault);
  const memory = new CounterpartyMemory(opts.ledgerPath === ":memory:" ? ":memory:" : join(home, "counterparty.db"), vault);

  if (opts.offline) {
    const oneclick = opts.oneclick ?? new FixtureOneClickClient();
    for (const [account, hash] of Object.entries(FIXTURE_PREVIOUS_CODE_HASH)) memory.acceptCodeHash(account, hash);
    const blocklistPath = join(home, "blocklist.offline.json");
    const blocklist = new SharedBlocklist(blocklistPath, issuer);
    for (const e of FIXTURE_BLOCKLIST) if (!blocklist.find(e.account)) blocklist.report(e);
    const preflight = new Preflight({
      oneclick,
      policy: opts.policy ?? DEMO_POLICY,
      ledger,
      pending,
      freeze,
      issuer,
      store,
      executor: opts.executor ?? new SimulatedExecutor(),
      counterparty: { blocklist, chain: opts.chain ?? new FixtureChainReader(FIXTURE_CHAIN), memory },
      tee: opts.tee ?? new SimulatedTeeChecker(join(home, "sim-enclave.key")),
      quoteManagerPublicKey: FIXTURE_MANAGER_PUBLIC_KEY,
      vault,
    });
    preflight.purgeExpired();
    return { preflight, ledger, pending, freeze, oneclick, blocklist, memory, store, vault };
  }

  const key = process.env.SEALED_POLICY_KEY;
  const policyPath = join(home, "policy.sealed.json");
  let policy = opts.policy;
  if (!policy) {
    if (!key || !existsSync(policyPath)) throw new Error("live mode needs SEALED_POLICY_KEY and .sealed/policy.sealed.json (run `pnpm policy:seal`)");
    policy = readSealedPolicy(policyPath, key);
  }
  const oneclick = new HttpOneClickClient();
  const blocklist = new SharedBlocklist(process.env.SEALED_BLOCKLIST ?? join(home, "blocklist.json"), issuer);
  const preflight = new Preflight({
    oneclick,
    policy,
    ledger,
    pending,
    freeze,
    issuer,
    store,
    executor: liveExecutor(oneclick),
    counterparty: { blocklist, chain: new RpcChainReader(), memory },
    tee: opts.tee ?? (process.env.NEARAI_API_KEY ? new NearAiCloudChecker() : undefined),
    vault,
  });
  preflight.purgeExpired();
  return { preflight, ledger, pending, freeze, oneclick, blocklist, memory, store, vault };
}

function liveExecutor(oneclick: HttpOneClickClient): Executor {
  if (process.env.OUTLAYER_API_KEY) return new OutLayerExecutor(oneclick);
  if (process.env.SEALED_ALLOW_SIMULATED_EXECUTOR === "1") return new SimulatedExecutor();
  throw new Error("live mode needs OUTLAYER_API_KEY (or SEALED_ALLOW_SIMULATED_EXECUTOR=1 for a preflight-only run)");
}

export function newPolicyKey(): string {
  return randomBytes(32).toString("hex");
}
