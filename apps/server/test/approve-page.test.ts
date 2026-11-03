import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AccessStore, ASSET, buildPreflight, DEMO_ACCOUNTS, FREEZE_MESSAGE, ReceiptStore, type ApprovalVerifier } from "@sealed-intent/core";
import { afterEach, describe, expect, it } from "vitest";
import { createRestServer } from "../src/rest-server";

type Json = Record<string, any>;
const SITE = "https://sein-near.vercel.app";

async function start(verify: ApprovalVerifier["verify"] = async () => true) {
  const dir = mkdtempSync(join(tmpdir(), "sein-approve-"));
  const env = buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: ":memory:" });
  const access = new AccessStore(":memory:");
  const server = createRestServer({ ...env, receipts: new ReceiptStore(join(dir, "out"), join(dir, ".sealed")), offline: true, access, ownerAccount: "owner.near", approvals: { verify }, webOrigins: [SITE], webUrl: SITE, publicUrl: "http://127.0.0.1:8787", network: "testnet", auth: { agentForToken: () => undefined, ownerToken: "owner-secret", ownerTokenGenerated: false } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const agent = access.issue("agent-1");
  const post = async (path: string, data: unknown, headers: Record<string, string> = {}): Promise<Json> => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
    return { http: r.status, ...((await r.json()) as Json) };
  };
  const warn = async () => (await post("/v1/preflight", { intent: { kind: "transfer", token: ASSET.USDC, amount: "5000000", recipient: DEMO_ACCOUNTS.newVendor, taskText: "Pay the new vendor's first invoice." } }, { Authorization: `Bearer ${agent}` })).decisionId as string;
  const links = async () => (await post("/v1/review/links", {}, { Authorization: "Bearer owner-secret" })).links as { decisionId: string; link: string }[];
  return { base, post, warn, links, close: () => server.close(), env };
}

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("the owner's review link", () => {
  it("names the site, the decision, the gateway and a key, with the private part after #", async () => {
    const s = await start();
    close = s.close;
    const id = await s.warn();
    const [l] = await s.links();
    expect(l!.decisionId).toBe(id);
    const u = new URL(l!.link);
    expect(`${u.origin}${u.pathname}`).toBe(`${SITE}/approve/${id}`);
    expect(u.search).toBe("");
    const p = new URLSearchParams(u.hash.slice(1));
    expect(p.get("g")).toBe("http://127.0.0.1:8787");
    expect(p.get("k")).toMatch(/^[0-9a-f]{48}$/);
  });

  it("only the owner can make links", async () => {
    const s = await start();
    close = s.close;
    expect((await s.post("/v1/review/links", {})).http).toBe(401);
  });

  it("the key reads that one decision and nothing else", async () => {
    const s = await start();
    close = s.close;
    const a = await s.warn();
    const b = await s.warn();
    const links = await s.links();
    const keyOf = (id: string) => new URLSearchParams(new URL(links.find((l) => l.decisionId === id)!.link).hash.slice(1)).get("k")!;
    const read = (id: string, key: string) => fetch(`${s.base}/v1/review/${id}`, { headers: { Authorization: `Review ${key}` } });
    const ok = await read(a, keyOf(a));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Json;
    expect(body).toMatchObject({ owner: "owner.near", network: "testnet", signRequired: true });
    expect(body.review.recipient).toBe(DEMO_ACCOUNTS.newVendor);
    expect((await read(a, keyOf(b))).status).toBe(401);
    expect((await read(a, "0".repeat(48))).status).toBe(401);
    expect((await fetch(`${s.base}/v1/review/${a}`)).status).toBe(401);
  });

  it("once decided, the link has nothing left to show", async () => {
    const s = await start();
    close = s.close;
    const id = await s.warn();
    const [l] = await s.links();
    await s.post("/v1/reject", { decisionId: id, signed: { action: "reject", decisionId: id, accountId: "owner.near", publicKey: "ed25519:x", signature: "ed25519:y", nonce: "AA==" } });
    const k = new URLSearchParams(new URL(l!.link).hash.slice(1)).get("k")!;
    expect((await fetch(`${s.base}/v1/review/${id}`, { headers: { Authorization: `Review ${k}` } })).status).toBe(404);
  });
});

describe("calls from the public site", () => {
  const preflight = (base: string, path: string, method: string, origin: string) => fetch(base + path, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Private-Network": "true" } });

  it("the site may call the review, approve, reject and freeze routes", async () => {
    const s = await start();
    close = s.close;
    for (const [path, method] of [["/v1/review/00000000-0000-0000-0000-000000000000", "GET"], ["/v1/approve", "POST"], ["/v1/reject", "POST"], ["/v1/freeze", "POST"]]) {
      const r = await preflight(s.base, path!, method!, SITE);
      expect(r.status).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
      expect(r.headers.get("access-control-allow-private-network")).toBe("true");
    }
  });

  it("no other site, and no agent or owner-only route", async () => {
    const s = await start();
    close = s.close;
    expect((await preflight(s.base, "/v1/approve", "POST", "https://evil.example")).status).toBe(403);
    for (const [path, method] of [["/v1/preflight", "POST"], ["/v1/execute", "POST"], ["/v1/unfreeze", "POST"], ["/v1/pending", "GET"], ["/v1/agents/issue", "POST"], ["/v1/review/links", "POST"]]) {
      const r = await preflight(s.base, path!, method!, SITE);
      expect(r.status).toBe(403);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("stopping every payment with a wallet signature", () => {
  const signed = (accountId = "owner.near") => ({ action: "freeze", accountId, publicKey: "ed25519:x", signature: "ed25519:y", nonce: "AA==" });

  it("the owner's signature freezes, and the message is the fixed freeze text", async () => {
    const seen: string[] = [];
    const s = await start(async (_a, m) => (seen.push(m), true));
    close = s.close;
    const r = await s.post("/v1/freeze", { signed: signed() });
    expect(r.frozen).toBe(true);
    expect(seen).toEqual([FREEZE_MESSAGE]);
  });

  it("another account, or a signature that does not check out, is refused", async () => {
    const s = await start(async () => false);
    close = s.close;
    expect((await s.post("/v1/freeze", { signed: signed() })).http).toBe(401);
    expect((await s.post("/v1/freeze", { signed: signed("mallory.near") })).http).toBe(401);
    expect(s.env.preflight.status().frozen).toBe(false);
  });

  it("a freeze signature cannot approve, and lifting the freeze still needs the owner token", async () => {
    const s = await start();
    close = s.close;
    const id = await s.warn();
    expect((await s.post("/v1/approve", { decisionId: id, signed: { ...signed(), action: "freeze", decisionId: id } })).http).toBe(400);
    await s.post("/v1/freeze", { signed: signed() });
    expect((await s.post("/v1/unfreeze", { signed: signed() })).http).toBe(401);
  });
});
