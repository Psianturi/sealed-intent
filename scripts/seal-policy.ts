#!/usr/bin/env tsx
/**
 * Encrypt a policy for live mode.
 *   SEALED_POLICY_KEY=<64 hex> pnpm policy:seal [path/to/policy.json]
 * Without a key, a new one is generated and printed ONCE: put it in .env.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { newPolicyKey, Policy, writeSealedPolicy } from "@sealed-intent/core";

const src = process.argv[2] ?? "fixtures/policy.example.json";
const policy = Policy.parse(JSON.parse(readFileSync(src, "utf8")));
let key = process.env.SEALED_POLICY_KEY;
if (!key) {
  key = newPolicyKey();
  console.log(`New SEALED_POLICY_KEY (save it in .env, it is not stored anywhere):\n${key}\n`);
}
mkdirSync(".sealed", { recursive: true });
writeSealedPolicy(".sealed/policy.sealed.json", policy, key);
console.log(`Sealed ${src} -> .sealed/policy.sealed.json (AES-256-GCM). Delete the plaintext copy if it holds real values.`);
