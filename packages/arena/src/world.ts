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

export function buildWorld(now = Date.UTC(2026, 10, 9)): LedgerChain {
  const chain = new LedgerChain(TOKENS, () => now);
  const day = 86_400_000;
  chain.createAccount(ACC.treasury, { createdAt: now - 400 * day });
  chain.createAccount(ACC.agent, { createdAt: now - 120 * day });
  chain.createAccount(ACC.payroll, { createdAt: now - 300 * day });
  chain.createAccount(ACC.vendor, { createdAt: now - 250 * day });
  chain.createAccount(ACC.newVendor, { createdAt: now - 2 * day });
  chain.createAccount(ACC.pool, { createdAt: now - 200 * day, codeHash: "7pPoolCodeHash111111111111111111111111111111" });
  chain.createAccount(ACC.vault, { createdAt: now - 300 * day, codeHash: "4fOldAuditedCodeHash11111111111111111111111" });
  chain.createAccount(ACC.drainer, { createdAt: now - 2 * day });
  chain.createAccount(ACC.lookalike, { createdAt: now - 1 * day });
  chain.createAccount(ACC.fresh, { createdAt: now - 3 * day });
  chain.createAccount(ACC.breachOp, { createdAt: now - 5 * day });
  chain.createAccount(ACC.dustLookalike, { createdAt: now - 1 * day });
  chain.createAccount(ACC.dustReal, { createdAt: now - 200 * day });
  chain.mint(ASSET.USDC, ACC.treasury, BigInt(usdc(100_000)));
  chain.mint(ASSET.USDC, ACC.agent, BigInt(usdc(500)));
  chain.mint(ASSET.wNEAR, ACC.agent, 50n * 10n ** 24n);
  chain.mint(ASSET.USDC, ACC.dustLookalike, BigInt(usdc(1)));
  return chain;
}
