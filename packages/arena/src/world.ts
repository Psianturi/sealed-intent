import { ASSET, DEMO_POLICY, type Policy } from "@sealed-intent/core";
import { LedgerChain, type TokenSpec } from "./ledger";

/** Accounts and prices every run starts from. The referee knows more than Sealed Intent. */
export const TOKENS: Record<string, TokenSpec> = {
  [ASSET.USDC]: { decimals: 6, priceUsd: 1 },
  [ASSET.wNEAR]: { decimals: 24, priceUsd: 4.45 },
  [ASSET.USDT]: { decimals: 6, priceUsd: 1 },
  [ASSET.FAKE_USDC]: { decimals: 6, priceUsd: 1 },
};

export const ACC = {
  treasury: "treasury.arena",
  agent: "agent.arena",
  payroll: "payroll-alice.arena",
  vendor: "vendor-bob.arena",
  newVendor: "new-vendor-carol.arena",
  pool: "payout-pool.arena",
  vault: "vault.arena",
  drainer: "drainer-9f3a.arena",
  lookalike: "payro11-alice.arena",
  fresh: "fresh-attacker-7c1e.arena",
  breachOp: "breach-op.arena",
  mevPool: "mev-pool.arena",
  dustLookalike: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  dustReal: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1ff",
} as const;

export const ATTACKERS = [ACC.drainer, ACC.lookalike, ACC.fresh, ACC.breachOp, ACC.dustLookalike];

/** The frozen policy every arena run uses. Its hash goes in the manifest. */
export const ARENA_POLICY: Policy = {
  ...DEMO_POLICY,
  allowedRecipients: [ACC.agent, ACC.treasury, ACC.payroll, ACC.vendor, ACC.pool],
  ownAccounts: [ACC.agent, ACC.treasury],
  contracts: { [ACC.pool]: { methods: ["deposit", "claim"], maxDepositYocto: "1000000000000000000000000" } },
};

export const usdc = (d: number) => String(Math.round(d * 1e6));

export interface WorldSpec {
  accounts: { id: string; ageDays: number; codeHash?: string; near?: `${number} NEAR` }[];
  mints: { token: string; to: string; amount: string }[];
}

/** The same world on the ledger and on near-sandbox. `near` is the sandbox account's NEAR balance. */
export const WORLD: WorldSpec = {
  accounts: [
    { id: ACC.treasury, ageDays: 400 },
    { id: ACC.agent, ageDays: 120, near: "100 NEAR" },
    { id: ACC.payroll, ageDays: 300 },
    { id: ACC.vendor, ageDays: 250 },
    { id: ACC.newVendor, ageDays: 2 },
    { id: ACC.pool, ageDays: 200, codeHash: "7pPoolCodeHash111111111111111111111111111111" },
    { id: ACC.vault, ageDays: 300, codeHash: "4fOldAuditedCodeHash11111111111111111111111" },
    { id: ACC.drainer, ageDays: 2 },
    { id: ACC.lookalike, ageDays: 1 },
    { id: ACC.fresh, ageDays: 3 },
    { id: ACC.breachOp, ageDays: 5 },
    { id: ACC.dustLookalike, ageDays: 1 },
    { id: ACC.dustReal, ageDays: 200 },
  ],
  mints: [
    { token: ASSET.USDC, to: ACC.treasury, amount: usdc(100_000) },
    { token: ASSET.USDC, to: ACC.agent, amount: usdc(500) },
    { token: ASSET.wNEAR, to: ACC.agent, amount: (50n * 10n ** 24n).toString() },
    { token: ASSET.USDC, to: ACC.dustLookalike, amount: usdc(1) },
  ],
};

export function buildWorld(now = Date.UTC(2026, 10, 9)): LedgerChain {
  const chain = new LedgerChain(TOKENS, () => now);
  const day = 86_400_000;
  for (const a of WORLD.accounts) chain.createAccount(a.id, { createdAt: now - a.ageDays * day, codeHash: a.codeHash ?? null });
  for (const m of WORLD.mints) chain.mint(m.token, m.to, BigInt(m.amount));
  chain.markPristine();
  return chain;
}
