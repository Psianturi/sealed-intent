import { buildPreflight } from "@sealed-intent/core";
import { authFromEnv } from "./auth";

/** Offline by default so anyone can run it. Set SEALED_MODE=live for mainnet. */
export function createApp() {
  const offline = (process.env.SEALED_MODE ?? "offline") !== "live";
  const env = buildPreflight({ offline });
  return { ...env, offline, auth: authFromEnv(process.env, offline) };
}
