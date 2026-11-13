// Starts the REST gateway with its background jobs. Used by `pnpm rest` and `pnpm sein start`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ReceiptStore } from "@sealed-intent/core";
import { createApp } from "./app";
import { createDemo, type DemoOptions } from "./demo";
import { createPayCheck, type PayCheckOptions } from "./paycheck";
import { createRestServer } from "./rest-server";

const UNITS: [RegExp, number, string][] = [[/^native$/, 24, "NEAR"], [/wrap\./, 24, "wNEAR"], [/17208628|usdc/, 6, "USDC"]];

function readable(amount: string | undefined, token: string | undefined): string {
  const u = token && UNITS.find(([re]) => re.test(token));
  if (!amount || !u || !/^\d+$/.test(amount)) return amount ? `${amount} ${token ?? ""}`.trim() : "";
  const padded = amount.padStart(u[1] + 1, "0");
  const part = padded.slice(-u[1]).replace(/0+$/, "");
  return `${padded.slice(0, -u[1])}${part ? "." + part : ""} ${u[2]}`;
}

export function startGateway(opts: { port?: number; host?: string; quiet?: boolean; demo?: DemoOptions; paycheck?: PayCheckOptions } = {}) {
  // a fresh instance accepts the wallet's past transactions, so history from before SeIn does not freeze it
  const firstRun = !existsSync(join(".sealed", "reconcile.db"));
  const app = createApp();
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const demo = opts.demo ? createDemo({ preflight: app.preflight, store: app.store }, opts.demo) : undefined;
  const paycheck = opts.paycheck ? createPayCheck(opts.paycheck) : undefined;
  const server = createRestServer({ ...app, receipts: new ReceiptStore(), demo, paycheck, lessonsPath: join(".sealed", "lessons.json") });

  server.listen(port, host, () => {
    if (opts.quiet) return;
    console.log(`Sealed Intent REST (${app.offline ? "offline" : "LIVE"}) on http://${host}:${port}`);
    if (app.auth.ownerTokenGenerated) console.log(`Owner token for /v1/approve and /v1/reject (set SEALED_OWNER_TOKEN to fix it): ${app.auth.ownerToken}`);
    if (app.offline && !process.env.SEALED_AGENT_TOKENS) console.log("Offline mode: unauthenticated agents are accepted as offline-agent. Set SEALED_AGENT_TOKENS for real agents.");
  });

  if (app.anchorer) {
    const tick = () => app.anchorer!.tick().catch((err: Error) => console.error(`anchoring: ${err.message}`));
    setInterval(tick, Number(process.env.SEALED_ANCHOR_INTERVAL_MS ?? 600_000)).unref();
  }

  if (app.reconciler) {
    const tick = () => app.reconciler!.tick().catch((err: Error) => console.error(`reconciliation: ${err.message}`));
    const begin = firstRun ? app.reconciler.accept().then(() => console.log("First start: the wallet's earlier transactions are accepted as they are.")) : Promise.resolve();
    void begin.catch((err: Error) => console.error(`reconciliation: ${err.message}`)).then(tick);
    setInterval(tick, Number(process.env.SEALED_RECONCILE_INTERVAL_MS ?? 60_000)).unref();
  }

  if (app.watcher) {
    const tick = () => app.watcher!.tick().catch((err: Error) => console.error(`account watcher: ${err.message}`));
    void tick();
    setInterval(tick, Number(process.env.SEALED_WATCH_INTERVAL_MS ?? 30_000)).unref();
  }

  // a payment that needs the owner shows up here at once, with a link to answer it with their wallet
  const shown = new Set<string>();
  const announce = () => {
    for (const r of app.preflight.reviewQueue()) {
      if (r.approvedBy || shown.has(r.decisionId)) continue;
      shown.add(r.decisionId);
      const link = `${app.webUrl}/approve/${r.decisionId}#g=${encodeURIComponent(app.publicUrl)}&k=${app.access.issueReviewKey(r.decisionId)}`;
      console.log(`\nWaiting for you: ${r.agentId} wants to pay ${readable(r.amount, r.token)} to ${r.recipient ?? "?"} (about $${r.usd.toFixed(2)}).`);
      console.log(`Flagged: ${r.warnCodes.join(", ") || "needs a person"}. Approve or reject with your wallet:\n${link}\n`);
    }
  };
  setInterval(announce, 2_000).unref();

  return { app, server };
}
