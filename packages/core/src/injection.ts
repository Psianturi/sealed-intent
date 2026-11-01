/**
 * Cheap, deterministic prompt-injection screen for the untrusted task text.
 * It is a first filter, not a guarantee; the private TEE check is the second
 * opinion, and the deterministic quote checks are what actually stop the money.
 */
const PATTERNS: { code: string; re: RegExp }[] = [
  { code: "INJECTION_OVERRIDE", re: /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,20}\b(instructions?|rules?|polic(y|ies))\b/i },
  { code: "INJECTION_DRAIN", re: /\b(send|transfer|move|withdraw|swap)\b.{0,30}\b(all|everything|entire|max(imum)?|full balance|whole)\b/i },
  { code: "INJECTION_ROLE", re: /\b(you are now|act as|new system prompt|developer mode|jailbreak)\b/i },
  { code: "INJECTION_SECRECY", re: /\b(don'?t|do not|never)\b.{0,20}\b(tell|report|log|mention)\b/i },
  { code: "INJECTION_URGENCY", re: /\b(urgent|immediately|right now|asap)\b.{0,40}\b(send|transfer|pay)\b/i },
];

// account-like strings: named NEAR accounts, 64-hex implicit accounts, EVM addresses
const ACCOUNT_RE = /\b([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:near|tg)|[0-9a-f]{64}|0x[0-9a-fA-F]{40})\b/g;

export interface InjectionScan {
  codes: string[];
  foreignAccounts: string[];
}

export function scanTaskText(text: string | undefined, knownAccounts: string[]): InjectionScan {
  if (!text) return { codes: [], foreignAccounts: [] };
  const codes = PATTERNS.filter((p) => p.re.test(text)).map((p) => p.code);
  const known = new Set(knownAccounts.map((a) => a.toLowerCase()));
  const foreignAccounts = [...new Set([...text.matchAll(ACCOUNT_RE)].map((m) => m[1]!.toLowerCase()))].filter(
    (a) => !known.has(a),
  );
  if (foreignAccounts.length > 0 && codes.length > 0) codes.push("INJECTION_FOREIGN_ACCOUNT");
  return { codes, foreignAccounts };
}
