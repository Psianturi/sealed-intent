// Plain words for reason codes, shared by every page.
export const REASON: Record<string, string> = {
  LIMIT_EXCEEDED: "A spending limit was reached",
  PROMPT_INJECTION_SUSPECTED: "The instruction looks like a trick",
  TEE_SIGNAL_BLOCK: "The enclave says it is unsafe",
  TEE_SIGNAL_WARN: "The enclave has doubts",
  TEE_UNVERIFIED: "The enclave could not be verified",
  TEE_UNAVAILABLE: "The enclave was unavailable",
  COUNTERPARTY_BLOCKLISTED: "The receiver is on the blocklist",
  COUNTERPARTY_REPORTED: "Another agent reported the receiver",
  COUNTERPARTY_NOT_FOUND: "The receiver does not exist",
  COUNTERPARTY_NEW_ACCOUNT: "The receiver is a new account",
  COUNTERPARTY_FIRST_CONTACT: "Never paid before",
  COUNTERPARTY_CODE_CHANGED: "The contract's code changed",
  RECIPIENT_NOT_ALLOWLISTED: "The receiver is not a known partner",
  RECIPIENT_LOOKALIKE: "The receiver's name imitates a known partner",
  ACTION_CLASS_FORBIDDEN: "This kind of action is never allowed",
  WALLET_FROZEN: "The wallet is frozen",
  LOOKALIKE_ASSET: "A look-alike token",
  EXCESSIVE_VALUE_LOSS: "The route loses too much value",
  ROUTE_NOT_CONFIDENTIAL: "A private payment on a public route",
  TASK_CONTEXT_MISSING: "The instruction was not provided",
  RPC_DISAGREEMENT: "Data sources disagree",
};

export const reason = (c: string) => REASON[c] ?? c.toLowerCase().replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase());
