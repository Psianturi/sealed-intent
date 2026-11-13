// Copies the official recording and a sample receipt into public/ so the site is static.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const pub = resolve(here, "..", "public");
const officials = ["official", "official-sandbox", "official-lazy"];
mkdirSync(join(pub, "replays"), { recursive: true });
for (const name of officials) if (existsSync(join(root, "replays", name))) cpSync(join(root, "replays", name), join(pub, "replays", name), { recursive: true });

// a real receipt from NEAR AI Cloud (evidence/tee), so the verify page always has a sample
const samples = join(pub, "samples");
mkdirSync(samples, { recursive: true });
cpSync(join(here, "..", "data", "sample-receipt.json"), join(samples, "receipt.json"));
cpSync(join(here, "..", "data", "sample-disclosure.json"), join(samples, "disclosure.json"));
// real testnet receipts, their proofs and a public index without amounts or receivers
const evidence = join(root, "evidence", "custody-testnet");
const approvalDir = join(evidence, "approval");
if (existsSync(join(evidence, "receipts"))) {
  const receiptDirs = [join(evidence, "receipts"), join(approvalDir, "receipts")].filter((d) => existsSync(d));
  for (const d of receiptDirs) cpSync(d, join(pub, "receipts"), { recursive: true });
  for (const d of [join(evidence, "proofs"), join(approvalDir, "proofs")]) if (existsSync(d)) cpSync(d, join(pub, "proofs"), { recursive: true });
  const all = receiptDirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(d, f), "utf8"))));
  const executions = new Map(all.filter((r) => r.version === "sealed-intent/execution@1").map((r) => [r.decisionId, r]));
  const receipts = all
    .filter((r) => r.version !== "sealed-intent/execution@1")
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
    .map((r) => ({ decisionId: r.receiptId, verdict: r.verdict, reasonCodes: r.reasonCodes ?? [], agent: r.public?.registeredAgent, issuedAt: r.issuedAt, status: executions.get(r.receiptId)?.status, executionReceiptId: executions.get(r.receiptId)?.receiptId }));
  const chain = JSON.parse(readFileSync(join(evidence, "chain.json"), "utf8"));
  writeFileSync(join(pub, "receipts", "index.json"), JSON.stringify({ ...chain, receipts }, null, 2));
  const flow = JSON.parse(readFileSync(join(evidence, "s4-flow.json"), "utf8"));
  mkdirSync(join(pub, "evidence"), { recursive: true });
  cpSync(join(evidence, "s4-flow.json"), join(pub, "evidence", "custody-flow.json"));
  // the one mainnet run: its two receipts open at /r/<id> like the testnet ones
  const mainnet = join(root, "evidence", "custody-mainnet");
  for (const f of ["allow-receipt.json", "block-receipt.json"]) if (existsSync(join(mainnet, f))) cpSync(join(mainnet, f), join(pub, "receipts", JSON.parse(readFileSync(join(mainnet, f), "utf8")).receiptId + ".json"));
  const sample = flow.steps.find((s) => s.txHash && s.chainMatchesIntent);
  if (sample) {
    cpSync(join(evidence, "receipts", sample.decisionId + ".json"), join(samples, "receipt.json"));
    for (const f of ["disclosure-tokenIn.json", "disclosure-amountIn.json", "disclosure-recipient.json"]) cpSync(join(evidence, f), join(samples, f));
  }

  // everything the proof page checks, gathered from the evidence folders
  const approval = existsSync(join(approvalDir, "approval.json")) ? JSON.parse(readFileSync(join(approvalDir, "approval.json"), "utf8")) : undefined;
  const quotePath = join(root, "evidence", "intents", "quote.json");
  const enclaveReceipt = approval ? all.find((r) => r.receiptId === approval.decisionId) : all.find((r) => r.tee);
  const payments = flow.steps.filter((s) => s.txHash).map((s) => ({ label: s.owner === "approved" ? "New receiver, paid after the owner approved" : s.name, hash: s.txHash, verdict: s.verdict, owner: s.owner }));
  if (approval) payments.push({ label: "New receiver, paid after the wallet signature shown below", hash: approval.execution.txHash, verdict: approval.verdict, owner: "approved" });
  // NEAR shows a contract's code as base58 of its sha256, so the committed build can be compared with the chain
  const wasm = join(root, "contracts", "sein-registry", "sein_registry.wasm");
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = existsSync(wasm) ? BigInt("0x" + createHash("sha256").update(readFileSync(wasm)).digest("hex")) : 0n;
  let codeHash = "";
  for (; n > 0n; n /= 58n) codeHash = B58[Number(n % 58n)] + codeHash;
  mkdirSync(join(pub, "proof"), { recursive: true });
  writeFileSync(join(pub, "proof", "data.json"), JSON.stringify({
    ...chain,
    codeHash: codeHash || undefined,
    setup: JSON.parse(readFileSync(join(evidence, "setup.json"), "utf8")).transactions,
    payments,
    refusedByCustody: flow.steps.filter((s) => s.refusedByCustody).length,
    bypass: { hash: flow.bypass.directTx, detectedSeconds: flow.bypass.detectedSeconds, frozenSeconds: flow.bypass.frozenSeconds, freezeTx: flow.bypass.frozenOnChainTx },
    enclave: enclaveReceipt?.tee ? { receiptId: enclaveReceipt.receiptId, model: enclaveReceipt.tee.model, signingAddress: enclaveReceipt.tee.signingAddress, tcbStatus: enclaveReceipt.tee.attestation?.tcbStatus, gpus: enclaveReceipt.tee.attestation?.gpus, tlsBound: enclaveReceipt.tee.attestation?.tlsBound } : undefined,
    approval,
    quote: existsSync(quotePath) ? JSON.parse(readFileSync(quotePath, "utf8")) : undefined,
  }, null, 2));
}
console.log("web data prepared");
