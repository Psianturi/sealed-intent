import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadOrCreateIssuerKey } from "@sealed-intent/receipt";
import { BudgetLedger } from "./budget";
import { CounterpartyMemory, FixtureChainReader, RpcChainReader, SharedBlocklist } from "./counterparty";
import { OutLayerExecutor, SimulatedExecutor } from "./executor";
import {
  DEMO_POLICY,
  FIXTURE_BLOCKLIST,
  FIXTURE_CHAIN,
  FIXTURE_MANAGER_PUBLIC_KEY,
  FIXTURE_PREVIOUS_CODE_HASH,
  FixtureOneClickClient,
} from "./fixtures";
import { HttpOneClickClient } from "./oneclick";
import { readSealedPolicy, type Policy } from "./policy";
import { Preflight } from "./preflight";
import { ReceiptStore } from "./store";
import { NearAiCloudChecker, SimulatedTeeChecker } from "./tee-check";

export interface BuildOptions {
  offline: boolean;
  home?: string; // where .sealed lives
  outDir?: string;
  policy?: Policy;
  ledgerPath?: string;
}

/**
 * Wire everything up.
 *  offline: fixture 1Click (signed with a fixture manager key), simulated TEE, simulated executor
 *  live:    real 1Click, NEAR AI Cloud (if NEARAI_API_KEY set), OutLayer custody (if OUTLAYER_API_KEY set)
 */
export interface Built {
  preflight: Preflight;
  ledger: BudgetLedger;
  oneclick: FixtureOneClickClient | HttpOneClickClient;
  blocklist: SharedBlocklist;
  memory: CounterpartyMemory;
}

export function buildPreflight(opts: BuildOptions): Built {
  const home = opts.home ?? ".sealed";
  const issuer = loadOrCreateIssuerKey(join(home, "issuer.pem"));
  const store = new ReceiptStore(opts.outDir ?? "out", home);
  const ledger = new BudgetLedger(opts.ledgerPath ?? join(home, "budget.db"));
  const memory = new CounterpartyMemory(opts.ledgerPath === ":memory:" ? ":memory:" : join(home, "counterparty.db"));

  if (opts.offline) {
    const oneclick = new FixtureOneClickClient();
    for (const [account, hash] of Object.entries(FIXTURE_PREVIOUS_CODE_HASH)) memory.swapCodeHash(account, hash);
    const blocklistPath = join(home, "blocklist.offline.json");
    const blocklist = new SharedBlocklist(blocklistPath, issuer);
    for (const e of FIXTURE_BLOCKLIST) if (!blocklist.find(e.account)) blocklist.report(e);
    const preflight = new Preflight({
      oneclick,
      policy: opts.policy ?? DEMO_POLICY,
      ledger,
      issuer,
      store,
      executor: new SimulatedExecutor(),
      counterparty: { blocklist, chain: new FixtureChainReader(FIXTURE_CHAIN), memory },
      tee: new SimulatedTeeChecker(join(home, "sim-enclave.key")),
      quoteManagerPublicKey: FIXTURE_MANAGER_PUBLIC_KEY,
    });
    return { preflight, ledger, oneclick, blocklist, memory };
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
    issuer,
    store,
    executor: process.env.OUTLAYER_API_KEY ? new OutLayerExecutor(oneclick) : new SimulatedExecutor(),
    counterparty: { blocklist, chain: new RpcChainReader(), memory },
    tee: process.env.NEARAI_API_KEY ? new NearAiCloudChecker() : undefined,
  });
  return { preflight, ledger, oneclick, blocklist, memory };
}

export function newPolicyKey(): string {
  return randomBytes(32).toString("hex");
}
