// x402: a service answers HTTP 402 with what it wants to be paid; the agent's wallet signs it. SeIn checks the
// request before anything is signed: the payee must be one the service itself publishes, on the right network,
// in an allowed asset, then the payment goes through SeIn's usual checks like any other transfer.

/** One row of a 402 answer's accepts[], as the NEAR Agent Market sends it. */
export interface X402Accept {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
}

/** What a service publishes at /.well-known/x402. */
export interface X402Recipients {
  x402Version?: number;
  recipients: { network: string; asset: string; payTo: string }[];
}

const bare = (asset: string) => asset.replace(/^nep141:/, "");

/** Reasons to refuse before any further check, as codes like every other SeIn verdict. */
export function x402Problems(accept: X402Accept, published: X402Recipients | undefined, network: "mainnet" | "testnet", maxTimeoutSeconds = 900): string[] {
  const problems: string[] = [];
  if (accept.scheme !== "exact") problems.push("X402_SCHEME_UNSUPPORTED");
  if (accept.network !== `near:${network}`) problems.push("X402_NETWORK_MISMATCH");
  if (!/^\d+$/.test(accept.amount) || BigInt(accept.amount) === 0n) problems.push("X402_BAD_AMOUNT");
  if ((accept.maxTimeoutSeconds ?? 0) > maxTimeoutSeconds) problems.push("X402_TIMEOUT_TOO_LONG");
  // the service's own list is the only source of truth for where its money goes; a payee it does not publish is a swap
  if (!published) problems.push("X402_PAYEE_UNPUBLISHED");
  else if (!published.recipients.some((r) => r.payTo === accept.payTo && r.network === accept.network && bare(r.asset) === bare(accept.asset))) problems.push("X402_PAYEE_NOT_PUBLISHED");
  return problems;
}

/** The transfer SeIn checks once the 402 itself is sound. */
export function x402Intent(accept: X402Accept, taskText: string) {
  return { kind: "transfer" as const, token: `nep141:${bare(accept.asset)}`, amount: accept.amount, recipient: accept.payTo, purpose: "x402", taskText };
}

/** Fetches the payees a service publishes, from the origin of the URL that asked for payment. */
export async function publishedRecipients(resourceUrl: string, fetcher: typeof fetch = fetch): Promise<X402Recipients | undefined> {
  const url = new URL(resourceUrl);
  if (url.protocol !== "https:") return undefined;
  const res = await fetcher(`${url.origin}/.well-known/x402`, { signal: AbortSignal.timeout(8000) }).catch(() => undefined);
  if (!res?.ok) return undefined;
  const body = (await res.json().catch(() => undefined)) as X402Recipients | undefined;
  return Array.isArray(body?.recipients) ? body : undefined;
}
