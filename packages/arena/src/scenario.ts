/**
 * Scenarios are data. A scenario is a list of steps built from a few primitives, so the
 * catalog, custom runs, tests and replays share one format.
 */
export type Origin = "near-native" | "ported" | "hypothetical";

export interface AgentAction {
  kind: "transfer" | "swap" | "call" | "add_key" | "deploy" | "sign_message";
  token?: string;
  tokenOut?: string;
  amount?: string;
  recipient?: string;
  contract?: string;
  method?: string;
  depositYocto?: string;
  publicKey?: string;
  codeHash?: string;
  message?: string;
  purpose?: string;
  memo?: string;
}

export type Step =
  /** a message in the agent's inbox; the scripted victim follows `ask` */
  | { type: "message"; from: string; text: string; ask: AgentAction }
  /** the tool layer rewrites or extends what the victim asked (compromised tool) */
  | { type: "message"; from: string; text: string; ask: AgentAction; toolAppends?: AgentAction[]; toolRewrites?: Partial<AgentAction> }
  /** a request that reaches the tool layer without going through the agent (breached path) */
  | { type: "path"; actions: AgentAction[]; label: string }
  /** something happens on chain before the next step */
  | { type: "chain"; op: "dust"; from: string; to: string; token: string; amount: string }
  | { type: "chain"; op: "deploy"; account: string; codeHash: string }
  | { type: "chain"; op: "drain"; from: string; to: string; token: string; amount: string; label: string }
  /** the chain reader used by the guard lies about an account */
  | { type: "lying_rpc"; account: string; codeHash: string }
  /** the quote source returns a route that loses this much value */
  | { type: "bad_quote"; haircutBps: number };

export interface Scenario {
  id: string;
  title: string;
  group: "legit" | "fooled" | "mistake" | "price" | "tool" | "signing" | "breach" | "checker" | "out-of-scope";
  origin: Origin;
  /** the incident whose pattern this follows, with a source the UI links to */
  pattern?: { incident: string; date: string; source: string };
  /** what must not happen, in one line */
  summary: string;
  /** attacker accounts that count as theft when they gain */
  attackers: string[];
  steps: Step[];
  /** what the sealed lane is expected to do; shown next to the result, never used by the referee */
  expectedSealed: "ALLOW" | "WARN" | "BLOCK" | "ESCAPES";
  mandatory: boolean;
  /** real-world note shown in the honesty panel */
  cannotReplicate?: string;
}

export interface Task {
  id: string;
  title: string;
  action: AgentAction;
  text: string;
}
