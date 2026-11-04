#!/usr/bin/env node
// Looks for keys in every version of every tracked file. Exits 1 on a finding and never prints the value.
import { execFileSync } from "node:child_process";

const PATTERNS = [
  ["custody API key", /\bwk_[A-Za-z0-9_-]{16,}/],
  ["NEAR private key", /\bed25519:[1-9A-HJ-NP-Za-km-z]{70,}/],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["provider API key", /\bsk-[A-Za-z0-9_-]{24,}/],
  ["assigned secret", /^\+.*\b(NEARAI_API_KEY|OUTLAYER_API_KEY|ONECLICK_JWT|SEALED_POLICY_KEY|SEALED_DATA_KEY|SEALED_OWNER_TOKEN|SEIN_[A-Z_]*KEY)=(?!\$)(?!isolation)[^\s<"'`]{12,}/m],
];
// NEAR public keys are also ed25519:base58, but at most 44 characters, so the length above tells them apart.
// A signature is as long as a private key, so a value held by a "signature" field is not a finding.
const SIGNATURE = /"signature"\s*:\s*"ed25519:[1-9A-HJ-NP-Za-km-z]+"/;

const log = execFileSync("git", ["log", "--all", "-p", "--no-color", "--unified=0", "--format=commit %h"], { maxBuffer: 1 << 30 }).toString("utf8");
let commit = "";
let file = "";
const findings = new Map();
for (const line of log.split("\n")) {
  if (line.startsWith("commit ")) commit = line.slice(7);
  else if (line.startsWith("+++ ")) file = line.slice(6);
  else if (line.startsWith("+") && !line.startsWith("+++")) {
    for (const [name, re] of PATTERNS) if (re.test(line.replace(SIGNATURE, ""))) findings.set(`${name} in ${file} at ${commit}`, true);
  }
}
if (findings.size) {
  for (const f of findings.keys()) console.error(`FOUND ${f}`);
  process.exit(1);
}
console.log("No secrets in the history.");
