import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Who is calling. Agents authenticate with a bearer token that maps to an agentId;
 * the owner has a separate token that only the approve/reject endpoints accept.
 */
export interface Auth {
  agentForToken(token: string | undefined): string | undefined;
  ownerToken: string;
  ownerTokenGenerated: boolean;
}

export function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

/**
 * SEALED_AGENT_TOKENS="tokenA=treasury-agent,tokenB=ops-agent"
 * SEALED_OWNER_TOKEN=<secret>   (generated and printed once when unset)
 * Offline mode with no agent tokens accepts unauthenticated calls as "offline-agent".
 */
export function authFromEnv(env: NodeJS.ProcessEnv, offline: boolean): Auth {
  const agents = new Map<string, string>();
  for (const pair of (env.SEALED_AGENT_TOKENS ?? "").split(",")) {
    const [token, agentId] = pair.split("=").map((s) => s.trim());
    if (token && agentId) agents.set(token, agentId);
  }
  const anonymous = offline && agents.size === 0 ? "offline-agent" : undefined;
  const ownerToken = env.SEALED_OWNER_TOKEN || randomBytes(24).toString("hex");
  return {
    agentForToken: (token) => (token ? agents.get(token) : anonymous),
    ownerToken,
    ownerTokenGenerated: !env.SEALED_OWNER_TOKEN,
  };
}
