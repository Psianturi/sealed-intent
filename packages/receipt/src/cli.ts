#!/usr/bin/env tsx
/**
 * Verify Sealed Intent receipts offline.
 *
 *   pnpm verify out/receipts/<id>.json
 *   pnpm verify out/receipts                       # every receipt in a folder
 *   pnpm verify <receipt> --disclose out/disclosures/<id>.recipient.json
 *   pnpm verify <receipt> --trust <issuer-public-key-hex>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyReceipt, type Disclosure, type Receipt } from "./receipt";

const args = process.argv.slice(2);
const targets: string[] = [];
const disclosures: Disclosure[] = [];
const trusted: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--disclose") disclosures.push(JSON.parse(readFileSync(args[++i]!, "utf8")));
  else if (a === "--trust") trusted.push(args[++i]!);
  else targets.push(a);
}
if (targets.length === 0) {
  console.error("usage: pnpm verify <receipt.json | folder> [--disclose file] [--trust pubkey]");
  process.exit(2);
}

const files = targets.flatMap((t) =>
  statSync(t).isDirectory()
    ? readdirSync(t).filter((f) => f.endsWith(".json")).map((f) => join(t, f))
    : [t],
);

let allValid = true;
for (const file of files) {
  const receipt = JSON.parse(readFileSync(file, "utf8")) as Receipt;
  const mine = disclosures.filter((d) => d.receiptId === receipt.receiptId);
  const report = verifyReceipt(receipt, { disclosures: mine, trustedIssuerKeys: trusted });
  allValid &&= report.valid;
  const tee = report.tee
    ? `tee=${report.tee.signatureValid && report.tee.textMatchesHashes ? "signature-ok" : "BAD"}${report.tee.simulated ? "(simulated)" : ""}${report.tee.attestationBound ? "+attested" : ""}`
    : "tee=none";
  console.log(
    `${report.valid ? "VALID  " : "INVALID"}  ${receipt.verdict.padEnd(5)}  ${receipt.receiptId}  ${tee}  reasons=[${receipt.reasonCodes.join(",")}]`,
  );
  for (const d of report.disclosures) {
    console.log(`         disclosed ${d.field}: ${d.matches ? JSON.stringify(d.value) : "DOES NOT MATCH"}`);
  }
  for (const p of report.problems) console.log(`         ! ${p}`);
}
process.exit(allValid ? 0 : 1);
