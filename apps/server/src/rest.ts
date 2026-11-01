#!/usr/bin/env tsx
// REST API for agents that do not speak MCP. Binds to localhost by default.
import { ReceiptStore } from "@sealed-intent/core";
import { createApp } from "./app";
import { createRestServer } from "./rest-server";

const app = createApp();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

createRestServer({ ...app, receipts: new ReceiptStore() }).listen(port, host, () => {
  console.log(`Sealed Intent REST (${app.offline ? "offline" : "LIVE"}) on http://${host}:${port}`);
  if (app.auth.ownerTokenGenerated) console.log(`Owner token for /v1/approve and /v1/reject (set SEALED_OWNER_TOKEN to fix it): ${app.auth.ownerToken}`);
  if (app.offline && !process.env.SEALED_AGENT_TOKENS) console.log("Offline mode: unauthenticated agents are accepted as offline-agent. Set SEALED_AGENT_TOKENS for real agents.");
});
