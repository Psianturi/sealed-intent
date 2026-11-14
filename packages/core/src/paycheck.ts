// Pay check: an opinion on one real payment before it is sent, from public chain facts only.
// No key, no custody, nothing stored. Rules decide; the enclave model can only make the answer stricter.
// ALLOW needs a receiver the payer has paid before; everything SeIn cannot confirm is a warning, never a pass.
import { imitates } from "./lookalike";

export interface PayFacts {
  to: string;
  /** who is paying; without it there is no history to compare with */
  payer?: string;
  /** this payment in NEAR, when it is a NEAR payment */
  amountNear?: number;
  /** undefined when the lookup failed */
  receiver?: { exists: boolean; isContract: boolean; createdAt?: number };
  /** accounts the payer sent to in its recent history, with how often; undefined when it could not be read */
  paidBefore?: Record<string, number>;
  /** NEAR amounts of the payer's recent transfers */
  pastAmounts?: number[];
  balanceNear?: number;
  reported?: string;
  /** what the instruction screen found in the message that asked for the payment */
  injectionCodes: string[];
  enclave?: { signal: "allow" | "warn" | "block"; attested: boolean; codes?: string[] };
  /** the message is only a few words, so the model was not asked */
  messageShort?: boolean;
  now: number;
}

export interface PayFinding {
  code: string;
  level: "block" | "warn" | "ok" | "info";
  text: string;
}

export interface PayCheck {
  verdict: "ALLOW" | "WARN" | "BLOCK";
  /** 0 calm, 100 certain trouble */
  risk: number;
  findings: PayFinding[];
}

const DAY = 86_400_000;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const near = (n: number) => `${Number(n.toFixed(n < 1 ? 4 : 2))} NEAR`;
const times = (n: number) => (n === 1 ? "once" : `${n} times`);

// the model's own reason, in plain words
const WHY: Record<string, string> = {
  INTENT_QUOTE_MISMATCH: "it does not clearly name this receiver or this amount",
  SUSPICIOUS_TASK_TEXT: "its wording looks unusual",
  SOCIAL_ENGINEERING: "it pushes, or claims authority",
  POLICY_CONFLICT: "it asks for something the rules would not allow",
};

export function payCheck(f: PayFacts): PayCheck {
  const out: PayFinding[] = [];
  let risk = 0;
  const add = (code: string, level: PayFinding["level"], text: string, weight = 0) => {
    out.push({ code, level, text });
    risk += weight;
  };
  const implicit = /^[0-9a-f]{64}$/.test(f.to);
  const before = f.paidBefore?.[f.to] ?? 0;

  // who gets it
  if (f.reported) add("RECEIVER_REPORTED", "block", `This account has been reported: ${f.reported}.`);
  if (!f.receiver) add("RECEIVER_UNKNOWN", "warn", "The receiver could not be looked up on chain right now, so nothing about it is confirmed.", 25);
  else if (!f.receiver.exists && !implicit) add("RECEIVER_MISSING", "block", "No account with this name exists on NEAR. A payment to it would fail or be lost.");
  else if (!f.receiver.exists) add("RECEIVER_UNUSED", "warn", "This address has never been used on chain. Check every character with the person you mean to pay.", 25);
  else {
    const age = f.receiver.createdAt ? Math.floor((f.now - f.receiver.createdAt) / DAY) : undefined;
    // a young account the payer already pays is not news
    if (age !== undefined && age < 30 && before) add("RECEIVER_AGE", "info", `The account is ${age} days old.`);
    else if (age !== undefined && age < 7) add("RECEIVER_NEW", "warn", `The account was created ${age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`}. Attackers use fresh accounts.`, 25);
    else if (age !== undefined && age < 30) add("RECEIVER_YOUNG", "warn", `The account is ${age} days old.`, 10);
    else if (age !== undefined) add("RECEIVER_AGE", "ok", `The account has existed for ${age >= 365 ? `${Math.floor(age / 365)} year${age >= 730 ? "s" : ""}` : `${age} days`}.`);
    if (f.receiver.isContract) add("RECEIVER_CONTRACT", "info", "The receiver is a contract, not a person's wallet.", 5);
  }

  // what the payer's own history says
  if (!f.payer) add("NO_PAYER", "warn", "Without the paying account SeIn cannot tell whether this receiver is familiar. Say who pays and it compares with that account's history.", 25);
  else if (!f.paidBefore) add("HISTORY_UNREAD", "warn", "The payer's history could not be read right now, so SeIn cannot tell whether this receiver is familiar.", 25);
  else {
    const known = Object.keys(f.paidBefore);
    const like = before ? undefined : imitates(f.to, known);
    if (like) add("RECEIVER_LOOKALIKE", "block", `The name passes for ${like}, which this account has paid ${times(f.paidBefore[like]!)}, but it is a different account. This is how address poisoning works.`);
    else if (before) add("PAID_BEFORE", "ok", `This account has paid it ${times(before)} before.`);
    else if (known.length) add("NEVER_PAID", "warn", `This account has never paid it, in its last ${known.length} receivers.`, 25);
    else add("NO_HISTORY", "warn", "The paying account has no earlier payments, so every receiver is new to it.", 25);
  }

  // how much
  if (f.amountNear !== undefined && f.amountNear > 0) {
    const past = (f.pastAmounts ?? []).filter((a) => a > 0);
    if (past.length >= 5 && f.amountNear > 5 * median(past)) add("AMOUNT_UNUSUAL", "warn", `${near(f.amountNear)} is ${Math.round(f.amountNear / median(past))} times this account's usual payment of ${near(median(past))}.`, 20);
    if (f.balanceNear && f.amountNear > f.balanceNear) add("AMOUNT_OVER_BALANCE", "warn", `The account holds ${near(f.balanceNear)}, less than this payment.`, 10);
    else if (f.balanceNear && f.amountNear / f.balanceNear >= 0.9) add("AMOUNT_WHOLE_BALANCE", "warn", `This is ${Math.round((f.amountNear / f.balanceNear) * 100)}% of the balance in one payment.`, 30);
    else if (f.balanceNear && f.amountNear / f.balanceNear >= 0.5) add("AMOUNT_HALF_BALANCE", "warn", `This is ${Math.round((f.amountNear / f.balanceNear) * 100)}% of the balance in one payment.`, 20);
  }

  // was the payer talked into it
  const tricks = f.injectionCodes.length > 0;
  if (tricks && f.enclave?.signal === "block") add("INSTRUCTION_TRICK", "block", "The message that asked for this reads like a trick: the screen flagged it, and the model in the enclave agrees.");
  else if (tricks) add("INSTRUCTION_SUSPICIOUS", "warn", "The message that asked for this uses the wording of a trick (pressure, secrecy, or an order to ignore rules).", 35);
  else if (f.enclave && f.enclave.signal !== "allow") {
    const reason = f.enclave.codes?.map((c) => WHY[c]).find(Boolean);
    const why = reason ? `: ${reason}` : "";
    // the model is one opinion: alone, it does not outweigh a receiver this account already pays, for a usual amount
    const alone = before > 0 && !out.some((x) => x.level === "warn" || x.level === "block");
    if (alone) add("ENCLAVE_NOTE", "info", `The model in the enclave is not sure about the message${why}. Nothing else about this payment looks wrong.`, 15);
    else if (f.enclave.signal === "block") add("ENCLAVE_OBJECTS", "warn", `The model in the enclave reads the message as unsafe${why}.`, 35);
    else add("ENCLAVE_UNSURE", "warn", `The model in the enclave is not comfortable with the message${why}.`, 15);
  } else if (f.enclave?.signal === "allow") add("INSTRUCTION_PLAIN", "ok", `The message reads like an ordinary request${f.enclave.attested ? ", judged inside a verified enclave" : ""}.`);
  else if (f.messageShort) add("MESSAGE_SHORT", "info", "The message is too short to judge, so SeIn looked at the receiver, the history and the amount only.");

  const blocked = out.some((x) => x.level === "block");
  const order = { block: 0, warn: 1, info: 2, ok: 3 } as const;
  return { verdict: blocked ? "BLOCK" : risk >= 25 ? "WARN" : "ALLOW", risk: blocked ? 100 : Math.min(risk, 95), findings: out.sort((a, b) => order[a.level] - order[b.level]) };
}
