#!/usr/bin/env tsx
/**
 * One owner approval on testnet, kept so anyone can recheck it: the decision, what the owner saw,
 * the NEP-413 wallet signature and the custody transaction that followed. Test tokens only.
 *   pnpm custody:approval
 * Then `pnpm registry anchor` and copy out/testnet/proofs/<id>.json into the proofs folder here.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Near, generateNonce } from "near-kit";
import { approvalMessage, APPROVAL_RECIPIENT, buildPreflight, ChainApprovalVerifier, checkApproval, CustodyLogSource, FastNearTxSource, loadEnv, NATIVE, Reconciler, reviewHash, RpcNonceReader } from "@sealed-intent/core";
import { verifyReceipt, type Receipt } from "@sealed-intent/receipt";
import { testnetPolicy } from "./testnet-policy";

loadEnv();
const need = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} is missing from .env`);
  return v;
};
if (process.env.SEALED_NETWORK !== "testnet") throw new Error("set SEALED_NETWORK=testnet");
const RPC = need("NEAR_RPC_URL");
const WALLET = need("OUTLAYER_NEAR_ACCOUNT");
const VENDOR = need("SEIN_TESTNET_VENDOR_ACCOUNT");
const ATTACKER = need("SEIN_TESTNET_ATTACKER_ACCOUNT");
const OWNER = need("SEIN_TESTNET_OWNER_ACCOUNT");
const OWNER_KEY = need("SEIN_TESTNET_OWNER_KEY");
const OUT = join("evidence", "custody-testnet", "approval");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const home = join(".sealed", "testnet");
const reconciler = new Reconciler(join(home, "reconcile.db"), {
  account: WALLET,
  sources: [new FastNearTxSource("https://tx.test.fastnear.com"), new CustodyLogSource(need("OUTLAYER_BASE_URL"), need("OUTLAYER_API_KEY"))],
  nonce: new RpcNonceReader(RPC),
  onMismatch: async () => undefined,
});
const { preflight, store } = buildPreflight({ offline: false, home, outDir: join("out", "testnet"), ledgerPath: join(home, "budget.db"), policy: testnetPolicy(WALLET, VENDOR), spendLog: reconciler });
preflight.unfreeze("approval evidence");
await reconciler.accept();

const intent = { kind: "transfer", purpose: "general", token: NATIVE, amount: (2n * 10n ** 21n).toString(), recipient: OWNER, taskText: "Send the monthly refund to the treasury account we opened this week." };
let d = await preflight.evaluate({ agentId: "testnet-agent", intent });
if (d.reasonCodes.includes("TEE_UNAVAILABLE")) d = await preflight.evaluate({ agentId: "testnet-agent", intent });
if (d.verdict !== "WARN") throw new Error(`expected WARN, got ${d.verdict} ${d.reasonCodes.join(",")}`);
const receipt = store.load(d.decisionId) as Receipt;
const review = preflight.review(d.decisionId)!;
const message = approvalMessage("approve", d.decisionId, reviewHash(review));

const near = new Near({ network: { networkId: "testnet", rpcUrl: RPC }, privateKey: OWNER_KEY as `ed25519:${string}`, defaultSignerId: OWNER });
const nonce = generateNonce();
const s = await near.signMessage({ message, recipient: APPROVAL_RECIPIENT, nonce }, { signerId: OWNER });
const signed = { action: "approve" as const, decisionId: d.decisionId, accountId: OWNER, publicKey: s.publicKey, signature: s.signature, nonce: Buffer.from(nonce).toString("base64") };
const verifier = new ChainApprovalVerifier("testnet", RPC);
const accepted = await checkApproval(signed, { owner: OWNER, review }, verifier);
const otherAccount = await checkApproval(signed, { owner: ATTACKER, review }, verifier);
if (!accepted.ok || otherAccount.ok) throw new Error("the approval check did not behave");

preflight.approve(d.decisionId, OWNER);
const x = await preflight.execute(d.decisionId, "testnet-agent");
if (!x.txHash) throw new Error(`custody did not send: ${x.status}`);

mkdirSync(join(OUT, "receipts"), { recursive: true });
const keep = (id: string, record: unknown) => writeFileSync(join(OUT, "receipts", `${id}.json`), JSON.stringify(record, null, 2) + "\n");
keep(d.decisionId, receipt);
if (x.executionReceiptId) keep(x.executionReceiptId, store.load(x.executionReceiptId));
const out = {
  ranAt: new Date().toISOString(),
  network: "testnet",
  decisionId: d.decisionId,
  verdict: d.verdict,
  warnCodes: d.warnCodes,
  receiptValid: verifyReceipt(receipt).valid,
  shownToOwner: review,
  reviewHash: reviewHash(review),
  message,
  recipient: APPROVAL_RECIPIENT,
  signed,
  checks: { acceptedForOwner: accepted.ok, refusedForAnotherAccount: !otherAccount.ok },
  execution: { status: x.status, executionReceiptId: x.executionReceiptId, txHash: x.txHash, explorer: `https://testnet.nearblocks.io/txns/${x.txHash}`, custodyWallet: WALLET },
};
writeFileSync(join(OUT, "approval.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`WARN ${d.warnCodes.join(",")} -> owner signed -> ${x.status} ${x.txHash}`);
process.exit(0);
