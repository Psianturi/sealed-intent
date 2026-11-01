/**
 * Freezes the custody wallet on chain, so the block holds even if the SeIn server is gone.
 * The server only holds a key limited to freeze_wallet: if it leaks, the thief can stop the
 * wallet but cannot unfreeze it, change the policy or move anything.
 */
export interface CustodyFreezer {
  freeze(): Promise<string | undefined>;
}

export interface OnChainFreezerConfig {
  account: string;
  key: string;
  walletPubkey: string;
  rpcUrl: string;
  networkId: string;
  contract: string;
}

export class OnChainFreezer implements CustodyFreezer {
  constructor(private readonly c: OnChainFreezerConfig) {}

  async freeze(): Promise<string | undefined> {
    const { Near } = await import("near-kit");
    const near = new Near({ network: { networkId: this.c.networkId, rpcUrl: this.c.rpcUrl }, privateKey: this.c.key as `ed25519:${string}`, defaultSignerId: this.c.account });
    const tx = await near.transaction(this.c.account).functionCall(this.c.contract, "freeze_wallet", { wallet_pubkey: this.c.walletPubkey }, { gas: "50 Tgas" }).send();
    return tx.transaction.hash;
  }
}

export function freezerFromEnv(env: NodeJS.ProcessEnv = process.env): CustodyFreezer | undefined {
  const { SEIN_FREEZE_ACCOUNT: account, SEIN_FREEZE_KEY: key, OUTLAYER_NEAR_ACCOUNT: wallet } = env;
  if (!account || !key || !wallet) return undefined;
  const testnet = env.SEALED_NETWORK === "testnet";
  return new OnChainFreezer({
    account,
    key,
    walletPubkey: `ed25519:${wallet}`,
    rpcUrl: env.NEAR_RPC_URL ?? (testnet ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com"),
    networkId: testnet ? "testnet" : "mainnet",
    contract: testnet ? "outlayer.testnet" : "outlayer.near",
  });
}
