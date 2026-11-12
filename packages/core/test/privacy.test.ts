// P1-P3: who sees what. Each test backs one cell of the matrix in the README.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDisclosure, verifyReceipt, type Receipt } from "@sealed-intent/receipt";
import { describe, expect, it } from "vitest";
import { buildPreflight } from "../src/config";
import { ASSET, DEMO_ACCOUNTS, DEMO_POLICY } from "../src/fixtures";
import type { Policy } from "../src/policy";
import { agentView } from "../src/preflight";

const usdc = (d: number) => String(Math.round(d * 1e6));
const SECRET_TEXT = "Pay the quarterly bonus for project zanzibar-417 now";
const pay = (over: Record<string, unknown> = {}) => ({ kind: "transfer", token: ASSET.USDC, amount: usdc(37.41), recipient: DEMO_ACCOUNTS.newVendor, purpose: "general", taskText: SECRET_TEXT, ...over });
const setup = (policy: Policy = DEMO_POLICY) => {
  const dir = mkdtempSync(join(tmpdir(), "sealed-priv-"));
  return { dir, env: buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: join(dir, ".sealed", "state.db"), policy }) };
};

/** Every file under a directory, raw bytes as text, so SQLite pages and WAL files count too. */
function allBytes(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allBytes(p));
    else out.push({ path: p, text: readFileSync(p).toString("latin1") });
  }
  return out;
}

describe("data at rest", () => {
  it("no amount, receiver or instruction is readable on disk, in receipts or in the database", async () => {
    const { dir, env } = setup();
    const logged: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      const d = await env.preflight.evaluate({ agentId: "treasury-bot-7", intent: pay() });
      expect(d.verdict).toBe("WARN");
      env.preflight.approve(d.decisionId, "owner");
      await env.preflight.execute(d.decisionId, "treasury-bot-7");
      await env.preflight.evaluate({ agentId: "treasury-bot-7", intent: pay({ amount: usdc(37.42) }) }); // left pending
    } finally {
      Object.assign(console, original);
    }
    const secrets = [usdc(37.41), usdc(37.42), DEMO_ACCOUNTS.newVendor, "zanzibar-417", "treasury-bot-7"];
    const files = allBytes(dir);
    expect(files.length).toBeGreaterThan(5);
    for (const { path, text } of files) for (const s of secrets) expect(text.includes(s), `${s} found in ${path}`).toBe(false);
    for (const s of secrets) expect(logged.join("\n").includes(s), `${s} found in the logs`).toBe(false);
  });

  it("the owner can still read what the disk hides", async () => {
    const { env } = setup();
    const d = await env.preflight.evaluate({ agentId: "a", intent: pay() });
    const [review] = env.preflight.reviewQueue();
    expect(review).toMatchObject({ decisionId: d.decisionId, agentId: "a", recipient: DEMO_ACCOUNTS.newVendor, amount: usdc(37.41), kind: "transfer" });
    expect(review?.warnCodes).toContain("RECIPIENT_NOT_ALLOWLISTED");
    expect(env.store.loadOpenings(d.decisionId)?.openings.recipient?.value).toBe(DEMO_ACCOUNTS.newVendor);
  });

  it("private records expire; the receipt stays valid but the field can no longer be opened", async () => {
    const { dir, env } = setup();
    const d = await env.preflight.evaluate({ agentId: "a", intent: pay() });
    const opening = join(dir, ".sealed", "openings", `${d.decisionId}.sealed`);
    const tee = join(dir, ".sealed", "tee", `${d.decisionId}.sealed`);
    expect(existsSync(opening) && existsSync(tee)).toBe(true);
    expect(env.preflight.purgeExpired()).toBe(0);
    const old = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(opening, old, old);
    utimesSync(tee, old, old);
    expect(env.preflight.purgeExpired()).toBeGreaterThanOrEqual(2);
    expect(existsSync(opening) || existsSync(tee)).toBe(false);
    expect(verifyReceipt(JSON.parse(readFileSync(d.receiptPath, "utf8")) as Receipt).valid).toBe(true);
    expect(env.store.loadOpenings(d.decisionId)).toBeUndefined();
  });
});

describe("what the agent sees", () => {
  it("no threshold, no allow-list and no detail in the agent's view or the public receipt", async () => {
    const { env } = setup();
    const d = await env.preflight.evaluate({ agentId: "a", intent: pay({ amount: usdc(80), recipient: DEMO_ACCOUNTS.payroll }) });
    expect(d.verdict).toBe("BLOCK");
    const view = agentView(d);
    expect(Object.keys(view).sort()).toEqual(["decisionId", "reasonCodes", "route", "verdict", "warnCodes"]);
    expect(view.reasonCodes).toEqual(["LIMIT_EXCEEDED"]);
    const receipt = readFileSync(d.receiptPath, "utf8");
    for (const leak of ["ABOVE_PER_TX_LIMIT", "perTxUsd", "allowedRecipients", DEMO_ACCOUNTS.payroll, usdc(80)]) expect(receipt.includes(leak), leak).toBe(false);
  });

  it("the owner can open which limit was hit", async () => {
    const { env } = setup();
    const d = await env.preflight.evaluate({ agentId: "a", intent: pay({ amount: usdc(80), recipient: DEMO_ACCOUNTS.payroll }) });
    expect(env.store.loadOpenings(d.decisionId)?.openings.limitDetail?.value).toEqual(["ABOVE_PER_TX_LIMIT"]);
    const receipt = JSON.parse(readFileSync(d.receiptPath, "utf8")) as Receipt;
    const disclosure = makeDisclosure(env.store.loadOpenings(d.decisionId)!, "limitDetail");
    expect(verifyReceipt(receipt, { disclosures: [disclosure] }).disclosures[0]).toMatchObject({ matches: true, value: ["ABOVE_PER_TX_LIMIT"] });
  });

  it("a tampered disclosure makes the receipt invalid", async () => {
    const { env } = setup();
    const d = await env.preflight.evaluate({ agentId: "a", intent: pay() });
    const receipt = JSON.parse(readFileSync(d.receiptPath, "utf8")) as Receipt;
    const honest = makeDisclosure(env.store.loadOpenings(d.decisionId)!, "amountIn");
    expect(verifyReceipt(receipt, { disclosures: [honest] }).valid).toBe(true);
    const forged = { ...honest, opening: { ...honest.opening, value: usdc(1) } };
    expect(verifyReceipt(receipt, { disclosures: [forged] }).valid).toBe(false);
  });

  it("the receipt and the enclave's signed request name the same intent commitment", async () => {
    const { env } = setup();
    const d = await env.preflight.evaluate({ agentId: "a", intent: pay() });
    const receipt = JSON.parse(readFileSync(d.receiptPath, "utf8")) as Receipt;
    const raw = env.store.loadTeeExchange(d.decisionId)!;
    const user = JSON.parse((JSON.parse(raw.request) as { messages: { content: string }[] }).messages[1]!.content) as { INTENT_COMMITMENT: string };
    expect(user.INTENT_COMMITMENT).toBe(receipt.commitments.intent);
    expect(verifyReceipt(receipt, { disclosures: [makeDisclosure(env.store.loadOpenings(d.decisionId)!, "intent")] }).valid).toBe(true);
  });
});

describe("the private route", () => {
  const swap = (over: Record<string, unknown> = {}) => ({ kind: "swap", tokenIn: ASSET.USDC, tokenOut: ASSET.wNEAR, amountIn: usdc(10), recipient: DEMO_ACCOUNTS.newVendor, refundTo: DEMO_ACCOUNTS.self, purpose: "payroll", taskText: "Pay the new contractor.", ...over });

  it("the owner is told what stays public and the measured extra cost before approving", async () => {
    const { env } = setup();
    const client = env.oneclick as unknown as { quote(r: { confidentiality?: string }): Promise<unknown>; behavior: { minOutHaircutBps?: number } };
    const quote = client.quote.bind(client);
    client.quote = async (r) => {
      client.behavior = { minOutHaircutBps: r.confidentiality ? 60 : 0 };
      return quote(r);
    };
    const d = await env.preflight.evaluate({ agentId: "a", intent: swap() });
    expect(d.verdict).toBe("WARN");
    expect(d.route).toBe("confidential-basic");
    const [review] = env.preflight.reviewQueue();
    expect(review?.routeNote?.hidden).toEqual(["the origin of the funds", "the route"]);
    expect(review?.routeNote?.stillPublic).toEqual(["the destination and what it receives"]);
    expect(review?.routeNote?.extraCostBps).toBeGreaterThanOrEqual(55);
    expect(review?.routeNote?.extraCostBps).toBeLessThanOrEqual(65);
  });

  it("a public-route quote handed in for a private purpose is refused", async () => {
    const { env } = setup();
    const publicQuote = await env.oneclick.quote({ dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: ASSET.USDC, depositType: "ORIGIN_CHAIN", destinationAsset: ASSET.wNEAR, amount: usdc(10), refundTo: DEMO_ACCOUNTS.self, refundType: "ORIGIN_CHAIN", recipient: DEMO_ACCOUNTS.payroll, recipientType: "DESTINATION_CHAIN", deadline: new Date(Date.now() + 300_000).toISOString() });
    const d = await env.preflight.evaluate({ agentId: "a", intent: swap({ recipient: DEMO_ACCOUNTS.payroll }), agentQuote: publicQuote });
    expect(d.verdict).toBe("BLOCK");
    expect(d.reasonCodes).toContain("AGENT_ROUTE_NOT_CONFIDENTIAL");
  });
});

/** The best an agent can do: bisect on BLOCK versus anything else. It only reads what it is given. */
async function bisect(env: ReturnType<typeof buildPreflight>, start: number, agentId = "prober") {
  let lo = 0;
  let hi = start;
  let asked = 0;
  let frozen = false;
  for (; asked < 30; asked++) {
    const mid = (lo + hi) / 2;
    const d = agentView(await env.preflight.evaluate({ agentId, intent: pay({ amount: usdc(mid), recipient: DEMO_ACCOUNTS.payroll }) }));
    if (d.reasonCodes.includes("WALLET_FROZEN")) {
      frozen = true;
      break;
    }
    if (d.verdict === "BLOCK") hi = mid;
    else lo = mid;
  }
  const estimate = (lo + hi) / 2;
  return { lo, hi, asked, frozen, relativeError: Math.abs(estimate - DEMO_POLICY.perTxUsd) / DEMO_POLICY.perTxUsd };
}

describe("probing for the limit", () => {
  it("without a prior guess the prober is frozen long before it knows the cap", async () => {
    const r = await bisect(setup().env, 10_000);
    expect(r.frozen).toBe(true);
    expect(r.asked).toBeLessThanOrEqual(7);
    expect(r.relativeError).toBeGreaterThan(0.5);
  });

  it("a fixed cap still leaks to a prober with a good guess, which is why jitter exists", async () => {
    const r = await bisect(setup().env, 120);
    expect(r.frozen).toBe(true);
    expect(r.relativeError).toBeLessThan(0.1);
  });

  it("with jitter on, even a good guess only finds the hourly draw, never the cap", async () => {
    const errors: number[] = [];
    for (let i = 0; i < 16; i++) {
      const r = await bisect(setup({ ...DEMO_POLICY, secrecy: { perTxJitterPct: 50 } }).env, 120, `prober-${i}`);
      expect(r.frozen).toBe(true);
      errors.push(r.relativeError);
    }
    // the prober cannot tell the draw from the cap: the answers spread across the band
    expect(Math.max(...errors)).toBeGreaterThan(0.2);
    expect(new Set(errors.map((e) => e.toFixed(2))).size).toBeGreaterThan(2);
  });

  it("thirty attempts end in a frozen wallet and every later request learns nothing", async () => {
    const { env } = setup();
    const answers = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const d = agentView(await env.preflight.evaluate({ agentId: "prober", intent: pay({ amount: usdc(55 + i), recipient: DEMO_ACCOUNTS.payroll }) }));
      answers.add(d.reasonCodes.join());
    }
    expect([...answers].sort()).toEqual(["LIMIT_EXCEEDED", "WALLET_FROZEN"]);
    expect(env.preflight.status().frozen).toBe(true);
  });
});
