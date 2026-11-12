// Risk outlook: what a wallet's public history says about how it is most likely to lose money.
// A reading of signals, not a promise: it cannot see the owner's device, seed phrase or inbox.
import { BAIT, KNOWN, distance, skeleton, type ScanInput, type ScanResult } from "./checkup-core";

export interface Tx {
  signer: string;
  receiver: string;
  actions: { action: string; method?: string | null }[];
  /** yoctoNEAR attached, as a decimal string */
  deposit: string;
  /** milliseconds since 1970 */
  time: number;
  ok: boolean;
}

export type Level = "low" | "elevated" | "high";
export interface Lane {
  id: "steered" | "keys" | "partners";
  title: string;
  level: Level;
  reasons: string[];
  action: string;
}
export interface Outlook {
  headline: string;
  basis: string;
  lanes: Lane[];
}

const HEX = /^[0-9a-f]{64}$/;
const DUST = 10n ** 21n; // 0.001 NEAR
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const yocto = (s: string) => {
  try {
    return BigInt(s || "0");
  } catch {
    return 0n;
  }
};

/** The name in `names` that `account` passes for at a glance, if any. */
export function passesFor(account: string, names: Iterable<string>): string | undefined {
  const s = skeleton(account);
  for (const t of names) {
    if (t === account || account.endsWith(`.${t}`) || t.endsWith(`.${account}`)) continue;
    if (HEX.test(account) && HEX.test(t)) {
      if (account.slice(0, 4) === t.slice(0, 4) && account.slice(-4) === t.slice(-4)) return t;
      continue;
    }
    if (skeleton(t) === s) return t;
    if (t.length >= 8 && Math.abs(t.length - account.length) <= 2 && distance(account, t) <= 2) return t;
  }
  return undefined;
}

const level = (high: boolean, elevated: boolean): Level => (high ? "high" : elevated ? "elevated" : "low");

export function outlook(input: ScanInput, result: ScanResult, txs: Tx[], who: { agent: boolean }): Outlook {
  const me = input.account;
  const out = txs.filter((t) => t.signer === me && t.receiver !== me);
  const inc = txs.filter((t) => t.receiver === me && t.signer !== me);
  const sentTo = new Set(out.map((t) => t.receiver));
  const known = KNOWN[input.network];

  // 1. being steered to the wrong account
  const copies = [...new Set(inc.map((t) => t.signer))].flatMap((s) => {
    if (sentTo.has(s)) return [];
    const real = passesFor(s, sentTo);
    return real ? [[s, real] as const] : [];
  });
  const dust = inc.filter((t) => !sentTo.has(t.signer) && t.actions.some((a) => a.action === "TRANSFER") && yocto(t.deposit) > 0n && yocto(t.deposit) <= DUST);
  const lures = result.findings.filter((f) => (f.kind === "token" || f.kind === "nft") && (f.severity === "danger" || f.severity === "caution"));
  const steered: string[] = [];
  for (const [fake, real] of copies.slice(0, 2)) steered.push(`${fake} sent to this wallet, and its name passes for ${real}, which this wallet has paid. Copying a receiver from the history would pay the wrong one.`);
  if (dust.length) steered.push(`${plural(dust.length, "tiny transfer")} from accounts it never paid. That is how an address gets planted in a wallet's history.`);
  if (lures.length) steered.push(`It holds ${plural(lures.length, "token or NFT", "tokens or NFTs")} that look like lures.`);

  // 2. keys that can act without the owner
  const full = input.keys.filter((k) => k.access_key.permission === "FullAccess").length;
  const badKeys = result.findings.filter((f) => f.kind === "key" && f.severity === "danger");
  const week = Date.now() - 7 * 86_400_000;
  const added = txs.filter((t) => t.receiver === me && t.time >= week && t.actions.some((a) => a.action === "ADD_KEY")).length;
  const stray = result.findings.some((f) => f.id === "intents-stray");
  const many = result.findings.some((f) => f.id === "many-keys");
  const keys: string[] = [];
  if (badKeys.length) keys.push(`${plural(badKeys.length, "app connection")} to a look-alike or reported contract. Cut ${badKeys.length === 1 ? "it" : "them"} below.`);
  if (full >= 3) keys.push(`${full} full-access keys. Each one is a complete copy of the account.`);
  if (added >= 3) keys.push(`${added} keys were added in the last seven days. Make sure each one was you.`);
  if (stray) keys.push("Keys inside NEAR Intents that a wallet's key list does not show.");
  if (many) keys.push("More app connections than anyone keeps track of. Old ones are risk with no use.");

  // 3. who it pays
  const reported = result.findings.filter((f) => f.kind === "contact" && f.severity === "danger");
  const baitCalls = out.filter((t) => !known[t.receiver] && (BAIT.test(t.receiver) || t.actions.some((a) => a.method && BAIT.test(a.method))));
  const pays = out.filter((t) => t.actions.some((a) => a.action === "TRANSFER"));
  const perReceiver = new Map<string, number>();
  for (const t of pays) perReceiver.set(t.receiver, (perReceiver.get(t.receiver) ?? 0) + 1);
  const once = [...perReceiver.values()].filter((n) => n === 1).length;
  const oneOff = once >= 4 && once / perReceiver.size >= 0.6;
  const partners: string[] = [];
  if (reported.length) partners.push(`It dealt with ${plural(reported.length, "reported account")}.`);
  if (baitCalls.length) partners.push(`It signed ${plural(baitCalls.length, "call")} with a lure in the name (claim, airdrop, reward) on contracts SeIn does not know.`);
  if (oneOff) partners.push(`${once} of ${perReceiver.size} receivers were paid only once. ${who.agent ? "For an agent, that is where a tricked payment hides." : "A first payment is where a wrong address costs the most."}`);

  const lanes: Lane[] = [
    {
      id: "steered",
      title: "Being steered to the wrong account",
      level: level(copies.length > 0, dust.length > 0 || lures.length > 0),
      reasons: steered.length ? steered : ["No look-alike senders, planted dust or lures in its recent history."],
      action: who.agent ? "Give the agent a list of trusted receivers. SeIn refuses a name that imitates one." : "Never copy a receiver from your history. Type it, or keep an address book.",
    },
    {
      id: "keys",
      title: "Keys that can act without you",
      level: level(badKeys.length > 0, full >= 3 || added >= 3 || stray || many),
      reasons: keys.length ? keys : [`${plural(full, "full-access key")} and no risky app connection.`],
      action: badKeys.length ? "Use Heal below to cut them with your own wallet." : "Delete the app connections you no longer use.",
    },
    {
      id: "partners",
      title: "Who it pays",
      level: level(reported.length > 0, baitCalls.length > 0 || oneOff),
      reasons: partners.length ? partners : ["No reported accounts or lure contracts among its recent partners."],
      action: who.agent ? "Put SeIn in front of this agent: a new receiver waits for the owner's signature." : "Confirm a new receiver through a second channel before the first payment.",
    },
  ];

  const rank = { high: 2, elevated: 1, low: 0 } as const;
  const worst = [...lanes].sort((a, b) => rank[b.level] - rank[a.level])[0]!;
  const headline = worst.level === "low" ? "No warning signs in its public history." : `Most exposed to: ${worst.title.toLowerCase()}.`;
  const basis = `Read from the last ${plural(txs.length, "transaction")}, ${plural(input.keys.length, "key")} and its holdings. A forecast, not a promise: it cannot see a device, a seed phrase or the messages an owner or an agent receives.`;
  return { headline, basis, lanes };
}
