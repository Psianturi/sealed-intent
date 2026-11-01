import type { QuoteResponse } from "./oneclick";

/**
 * Verify a 1Click quote signature with the official SDK function
 * (`verifyQuoteSignature`: ed25519 over base58(sha256(stable-json(request+quote+timestamp)))).
 *
 * Live mode uses the SDK's built-in 1Click manager key. Offline mode passes the
 * fixture manager key, so the exact same verification code runs in the demo.
 */
type SdkModule = {
  verifyQuoteSignature: (r: unknown, managerPublicKey?: string) => boolean;
  quoteHash: (r: unknown) => string;
};

let sdk: SdkModule | null | undefined;

async function loadSdk(): Promise<SdkModule | null> {
  if (sdk !== undefined) return sdk;
  try {
    sdk = (await import("@defuse-protocol/one-click-sdk-typescript")) as unknown as SdkModule;
  } catch {
    sdk = null;
  }
  return sdk;
}

export type QuoteSignatureStatus = "valid" | "invalid" | "unavailable";

export async function checkQuoteSignature(response: QuoteResponse, managerPublicKey?: string): Promise<QuoteSignatureStatus> {
  const mod = await loadSdk();
  if (!mod) return "unavailable";
  return mod.verifyQuoteSignature(response, managerPublicKey) ? "valid" : "invalid";
}

export async function quoteHashOf(response: QuoteResponse): Promise<string | null> {
  const mod = await loadSdk();
  return mod ? mod.quoteHash(response) : null;
}
