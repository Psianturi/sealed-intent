import { NATIVE } from "./executor";
import { HttpOneClickClient, type OneClickClient, type QuoteRequest, type QuoteResponse, type TokenResponse } from "./oneclick";

/**
 * Intents and 1Click do not exist on testnet, so tokens are valued at their mainnet price and
 * every swap quote fails, which SeIn turns into a block. Transfers and calls work normally.
 */
export const TESTNET_ASSET = { NEAR: NATIVE, wNEAR: "nep141:wrap.testnet", USDC: "nep141:usdc.fakes.testnet" } as const;

export class TestnetCatalogClient implements OneClickClient {
  readonly mode = "live" as const;

  constructor(private readonly prices: Pick<OneClickClient, "getTokens"> = new HttpOneClickClient()) {}

  async getTokens(): Promise<TokenResponse[]> {
    const main = await this.prices.getTokens();
    const near = main.find((t) => t.assetId === "nep141:wrap.near");
    if (!near) throw new Error("no NEAR reference price");
    const token = (assetId: string, symbol: string, decimals: number, price: number): TokenResponse => ({ assetId, symbol, decimals, price, blockchain: "near", priceUpdatedAt: near.priceUpdatedAt });
    return [token(TESTNET_ASSET.NEAR, "NEAR", 24, near.price), token(TESTNET_ASSET.wNEAR, "wNEAR", 24, near.price), token(TESTNET_ASSET.USDC, "USDC", 6, 1), near];
  }

  async quote(_req: QuoteRequest): Promise<QuoteResponse> {
    throw new Error("NEAR Intents is mainnet only");
  }
}
