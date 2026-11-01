/**
 * Minimal 1Click (NEAR Intents) client.
 * Field names follow the official OpenAPI spec: https://1click.chaindefuser.com/docs/v0/openapi.yaml
 */

export type Confidentiality = "public" | "basic" | "advanced";

export interface TokenResponse {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt: string;
  contractAddress?: string;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT" | "ANY_INPUT";
  slippageTolerance: number; // basis points
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  deadline: string;
  confidentiality?: Confidentiality;
  referral?: string;
  quoteWaitingTimeMs?: number;
  [extra: string]: unknown;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd: string;
  minAmountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  deadline?: string;
  timeWhenInactive?: string;
  timeEstimate: number;
  [extra: string]: unknown;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export interface OneClickClient {
  readonly mode: "live" | "offline";
  getTokens(): Promise<TokenResponse[]>;
  quote(req: QuoteRequest): Promise<QuoteResponse>;
  submitDeposit?(txHash: string, depositAddress: string, nearSenderAccount?: string): Promise<unknown>;
  status?(depositAddress: string): Promise<{ status: string; [k: string]: unknown }>;
}

export class HttpOneClickClient implements OneClickClient {
  readonly mode = "live" as const;
  private tokenCache?: { at: number; tokens: TokenResponse[] };

  constructor(
    private readonly baseUrl = process.env.ONECLICK_BASE_URL ?? "https://1click.chaindefuser.com",
    private readonly jwt = process.env.ONECLICK_JWT,
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (this.jwt) h.Authorization = `Bearer ${this.jwt}`;
    return h;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers: this.headers() });
    const text = await res.text();
    if (!res.ok) throw new Error(`1Click ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async getTokens(): Promise<TokenResponse[]> {
    if (this.tokenCache && Date.now() - this.tokenCache.at < 60_000) return this.tokenCache.tokens;
    const tokens = await this.request<TokenResponse[]>("/v0/tokens");
    this.tokenCache = { at: Date.now(), tokens };
    return tokens;
  }

  quote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("/v0/quote", { method: "POST", body: JSON.stringify(req) });
  }

  submitDeposit(txHash: string, depositAddress: string, nearSenderAccount?: string): Promise<unknown> {
    return this.request("/v0/deposit/submit", {
      method: "POST",
      body: JSON.stringify({ txHash, depositAddress, nearSenderAccount }),
    });
  }

  status(depositAddress: string): Promise<{ status: string }> {
    return this.request(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  }
}
