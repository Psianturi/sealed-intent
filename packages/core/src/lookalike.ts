// Address poisoning: a receiver whose name passes for a trusted one at a glance.

// characters that look alike once printed
const SKELETON: [RegExp, string][] = [[/0/g, "o"], [/[1il|]/g, "l"], [/3/g, "e"], [/5/g, "s"], [/rn/g, "m"], [/vv/g, "w"], [/[-_.]/g, ""]];
export const skeleton = (s: string) => SKELETON.reduce((t, [re, to]) => t.replace(re, to), s.toLowerCase());

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

const HEX = /^[0-9a-f]{64}$/;

/** The trusted account this one imitates, if any. A trusted account never imitates itself, and its sub-accounts never imitate it. */
export function imitates(account: string, trusted: string[]): string | undefined {
  if (trusted.includes(account)) return undefined;
  const s = skeleton(account);
  for (const t of trusted) {
    if (account.endsWith(`.${t}`)) continue;
    // implicit accounts are compared the way people read them: the first and last characters
    if (HEX.test(account) && HEX.test(t)) {
      if (account.slice(0, 4) === t.slice(0, 4) && account.slice(-4) === t.slice(-4)) return t;
      continue;
    }
    const k = skeleton(t);
    if (k === s) return t;
    if (k.length >= 8 && s.includes(k)) return t;
    if (t.length >= 8 && Math.abs(t.length - account.length) <= 2 && distance(account, t) <= 2) return t;
  }
  return undefined;
}
