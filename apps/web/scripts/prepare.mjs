// Copies the official recording and a sample receipt into public/ so the site is static.
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
if (existsSync(join(evidence, "receipts"))) {
  cpSync(join(evidence, "receipts"), join(pub, "receipts"), { recursive: true });
  if (existsSync(join(evidence, "proofs"))) cpSync(join(evidence, "proofs"), join(pub, "proofs"), { recursive: true });
  const read = (f) => JSON.parse(readFileSync(join(evidence, "receipts", f), "utf8"));
  const all = readdirSync(join(evidence, "receipts")).filter((f) => f.endsWith(".json")).map(read);
  const executions = new Map(all.filter((r) => r.version === "sealed-intent/execution@1").map((r) => [r.decisionId, r]));
  const receipts = all
    .filter((r) => r.version !== "sealed-intent/execution@1")
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
    .map((r) => ({ decisionId: r.receiptId, verdict: r.verdict, agent: r.public?.registeredAgent, issuedAt: r.issuedAt, status: executions.get(r.receiptId)?.status, executionReceiptId: executions.get(r.receiptId)?.receiptId }));
  const chain = JSON.parse(readFileSync(join(evidence, "chain.json"), "utf8"));
  writeFileSync(join(pub, "receipts", "index.json"), JSON.stringify({ ...chain, receipts }, null, 2));
  const flow = JSON.parse(readFileSync(join(evidence, "s4-flow.json"), "utf8"));
  const sample = flow.steps.find((s) => s.txHash && s.chainMatchesIntent);
  if (sample) {
    cpSync(join(evidence, "receipts", sample.decisionId + ".json"), join(samples, "receipt.json"));
    for (const f of ["disclosure-tokenIn.json", "disclosure-amountIn.json", "disclosure-recipient.json"]) cpSync(join(evidence, f), join(samples, f));
  }
}
console.log("web data prepared");
