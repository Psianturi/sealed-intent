#!/usr/bin/env tsx
/**
 * Reveal ONE private field of a receipt to someone (an auditor, a tax advisor, a judge)
 * without revealing anything else.
 *
 *   pnpm disclose --receipt <id> --field amount
 *   pnpm disclose <id> recipient
 *
 * Decrypts .sealed/openings/<id>.sealed and writes out/disclosures/<id>.<field>.json. Give
 * that file plus the public receipt to the other party; they check it on the verify page
 * or with `pnpm verify <receipt> --disclose <file>`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDisclosure, PRIVATE_FIELDS, type PrivateField, type PrivateOpenings } from "./receipt";
import { loadEnv, loadVault } from "./vault";

const FRIENDLY: Record<string, string> = { amount: "amountIn", receiver: "recipient", token: "tokenIn", instruction: "taskText", agent: "agentId" };
const argv = process.argv.slice(2);
const flag = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const receiptId = flag("--receipt") ?? positional[0];
const requested = flag("--field") ?? positional[1];
const field = requested && (FRIENDLY[requested] ?? requested);
const allowed = [...PRIVATE_FIELDS, "policy"] as string[];
if (!receiptId || !field || !allowed.includes(field)) {
  console.error(`usage: pnpm disclose --receipt <id> --field <${[...Object.keys(FRIENDLY), ...allowed].join("|")}>`);
  process.exit(2);
}
loadEnv();
const root = process.env.SEALED_HOME ?? ".sealed";
const openings = loadVault(root).open<PrivateOpenings>(readFileSync(join(root, "openings", `${receiptId}.sealed`), "utf8"));
const disclosure = makeDisclosure(openings, field as PrivateField | "policy");
mkdirSync(join("out", "disclosures"), { recursive: true });
const out = join("out", "disclosures", `${receiptId}.${field}.json`);
writeFileSync(out, JSON.stringify(disclosure, null, 2));
console.log(`wrote ${out}`);
