#!/usr/bin/env tsx
/**
 * Reveal ONE private field of a receipt to someone (an auditor, a tax advisor, a judge)
 * without revealing anything else.
 *
 *   pnpm disclose <receiptId> <field>      e.g. pnpm disclose 6f1c... recipient
 *
 * Reads the private openings from .sealed/openings/<id>.json and writes
 * out/disclosures/<id>.<field>.json. Give that file plus the public receipt to the
 * other party; they run `pnpm verify <receipt> --disclose <file>`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDisclosure, PRIVATE_FIELDS, type PrivateField, type PrivateOpenings } from "./receipt";

const [receiptId, field] = process.argv.slice(2);
const allowed = [...PRIVATE_FIELDS, "policy"];
if (!receiptId || !field || !allowed.includes(field)) {
  console.error(`usage: pnpm disclose <receiptId> <${allowed.join("|")}>`);
  process.exit(2);
}
const root = process.env.SEALED_HOME ?? ".sealed";
const openings = JSON.parse(readFileSync(join(root, "openings", `${receiptId}.json`), "utf8")) as PrivateOpenings;
const disclosure = makeDisclosure(openings, field as PrivateField | "policy");
mkdirSync(join("out", "disclosures"), { recursive: true });
const out = join("out", "disclosures", `${receiptId}.${field}.json`);
writeFileSync(out, JSON.stringify(disclosure, null, 2));
console.log(`wrote ${out}`);
