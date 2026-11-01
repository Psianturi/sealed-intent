import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { AccessStore, approvalMessage, ASSET, buildPreflight, DEMO_ACCOUNTS, ReceiptStore, requestToSign, reviewHash, type ApprovalVerifier, type OwnerReview, type SignedApproval } from "@sealed-intent/core";
import { afterEach, describe, expect, it } from "vitest";
import { createRestServer } from "../src/rest-server";

type Json = Record<string, any>;
const intent = (over: Record<string, unknown> = {}) => ({ kind: "transfer", token: ASSET.USDC, amount: "5000000", recipient: DEMO_ACCOUNTS.payroll, taskText: "Pay the October invoice.", ...over });

function start(opts: { ownerAccount?: string; approvals?: ApprovalVerifier; rpm?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sein-gw-"));
  const env = buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: ":memory:" });
  const access = new AccessStore(":memory:");
  const server = createRestServer({ ...env, receipts: new ReceiptStore(join(dir, "out"), join(dir, ".sealed")), offline: true, access, ownerAccount: opts.ownerAccount, approvals: opts.approvals, agentRequestsPerMinute: opts.rpm, auth: { agentForToken: () => undefined, ownerToken: "owner-secret", ownerTokenGenerated: false } });
  return new Promise<{ base: string; access: AccessStore; close: () => void; env: typeof env }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, access, env, close: () => server.close() })),
  );
}
const post = (base: string, path: string, data: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

let close: (() => void) | undefined;
afterEach(() => close?.());

describe("agent access", () => {
  it("every answer names the API version", async () => {
    const s = await start();
    close = s.close;
    expect((await fetch(`${s.base}/health`)).headers.get("SeIn-Api-Version")).toBe("1");
  });

  it("a token is shown once, kept only as a hash, and can be revoked at once", async () => {
    const s = await start();
    close = s.close;
    const issued = (await (await post(s.base, "/v1/agents/issue", { agentId: "agent-1" }, bearer("owner-secret"))).json()) as Json;
    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await post(s.base, "/v1/preflight", { intent: intent() }, bearer(issued.token))).status).toBe(200);
    expect((await post(s.base, "/v1/agents/revoke", { agentId: "agent-1" }, bearer("owner-secret"))).status).toBe(200);
    expect((await post(s.base, "/v1/preflight", { intent: intent() }, bearer(issued.token))).status).toBe(401);
  });

  it("only the owner can issue or revoke", async () => {
    const s = await start();
    close = s.close;
    const t = s.access.issue("agent-1");
    expect((await post(s.base, "/v1/agents/issue", { agentId: "x" }, bearer(t))).status).toBe(401);
    expect((await post(s.base, "/v1/agents/revoke", { agentId: "agent-1" }, bearer(t))).status).toBe(401);
  });

  it("a stolen token alone cannot speak for an agent that has a key", async () => {
    const s = await start();
    close = s.close;
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const hex = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32).toString("hex");
    const t = s.access.issue("agent-1", hex);
    const signed = (raw: string, ts = String(Date.now()), key = privateKey) => ({ ...bearer(t), "X-SeIn-Timestamp": ts, "X-SeIn-Signature": sign(null, Buffer.from(requestToSign(ts, "POST", "/v1/preflight", raw)), key).toString("hex") });
    const body = { intent: intent() };
    const raw = JSON.stringify(body);

    expect((await post(s.base, "/v1/preflight", body, bearer(t))).status).toBe(401);
    const good = signed(raw);
    expect((await post(s.base, "/v1/preflight", body, good)).status).toBe(200);
    // the same signed request cannot be sent twice
    expect((await post(s.base, "/v1/preflight", body, good)).status).toBe(401);
    // an old one is refused
    expect((await post(s.base, "/v1/preflight", body, signed(raw, String(Date.now() - 300_000)))).status).toBe(401);
    // a signature for another body is refused
    expect((await post(s.base, "/v1/preflight", { intent: intent({ amount: "6000000" }) }, signed(raw))).status).toBe(401);
    // and so is another key
    expect((await post(s.base, "/v1/preflight", body, signed(raw, undefined, generateKeyPairSync("ed25519").privateKey))).status).toBe(401);
  });

  it("one agent cannot exceed its request limit, and another is not affected", async () => {
    const s = await start({ rpm: 2 });
    close = s.close;
    const a = s.access.issue("agent-a");
    const b = s.access.issue("agent-b");
    expect((await post(s.base, "/v1/preflight", { intent: intent() }, bearer(a))).status).toBe(200);
    expect((await post(s.base, "/v1/preflight", { intent: intent() }, bearer(a))).status).toBe(200);
    expect((await post(s.base, "/v1/preflight", { intent: intent() }, bearer(a))).status).toBe(429);
    expect((await post(s.base, "/v1/preflight", { intent: intent() }, bearer(b))).status).toBe(200);
  });
});

describe("no double payments", () => {
  it("a repeated key gets the first answer and creates no second decision", async () => {
    const s = await start();
    close = s.close;
    const t = s.access.issue("agent-1");
    const h = { ...bearer(t), "Idempotency-Key": "k1" };
    const first = (await (await post(s.base, "/v1/preflight", { intent: intent() }, h)).json()) as Json;
    const second = await post(s.base, "/v1/preflight", { intent: intent() }, h);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");
    expect(((await second.json()) as Json).decisionId).toBe(first.decisionId);
  });

  it("a repeated execute returns the same result, and the payment runs once", async () => {
    const s = await start();
    close = s.close;
    const t = s.access.issue("agent-1");
    const d = (await (await post(s.base, "/v1/preflight", { intent: intent() }, bearer(t))).json()) as Json;
    const h = { ...bearer(t), "Idempotency-Key": "pay-1" };
    const one = (await (await post(s.base, "/v1/execute", { decisionId: d.decisionId }, h)).json()) as Json;
    const two = (await (await post(s.base, "/v1/execute", { decisionId: d.decisionId }, h)).json()) as Json;
    expect(one.status).toBe("simulated");
    expect(two).toEqual(one);
    const three = (await (await post(s.base, "/v1/execute", { decisionId: d.decisionId }, { ...bearer(t), "Idempotency-Key": "pay-2" })).json()) as Json;
    expect(three.status).toBe("not_sent");
  });

  it("the same key from another agent is a different request", async () => {
    const s = await start();
    close = s.close;
    const h = (t: string) => ({ ...bearer(t), "Idempotency-Key": "same" });
    const a = (await (await post(s.base, "/v1/preflight", { intent: intent() }, h(s.access.issue("a")))).json()) as Json;
    const b = (await (await post(s.base, "/v1/preflight", { intent: intent() }, h(s.access.issue("b")))).json()) as Json;
    expect(a.decisionId).not.toBe(b.decisionId);
  });
});

describe("the owner approves with a wallet signature", () => {
  const warn = () => intent({ recipient: DEMO_ACCOUNTS.newVendor });
  const accepts: ApprovalVerifier = { verify: async () => true };
  const signedFor = (decisionId: string, action: SignedApproval["action"] = "approve", accountId = "owner.near"): SignedApproval => ({ action, decisionId, accountId, publicKey: "ed25519:x", signature: "ed25519:y", nonce: "AA==" });

  it("the old owner token is no longer enough", async () => {
    const s = await start({ ownerAccount: "owner.near", approvals: accepts });
    close = s.close;
    const t = s.access.issue("agent-1");
    const d = (await (await post(s.base, "/v1/preflight", { intent: warn() }, bearer(t))).json()) as Json;
    expect(d.verdict).toBe("WARN");
    expect((await post(s.base, "/v1/approve", { decisionId: d.decisionId, approver: "me" }, bearer("owner-secret"))).status).toBe(401);
  });

  it("a signature from the owner approves", async () => {
    const s = await start({ ownerAccount: "owner.near", approvals: accepts });
    close = s.close;
    const t = s.access.issue("agent-1");
    const d = (await (await post(s.base, "/v1/preflight", { intent: warn() }, bearer(t))).json()) as Json;
    expect((await post(s.base, "/v1/approve", { decisionId: d.decisionId, signed: signedFor(d.decisionId) })).status).toBe(200);
    expect(((await (await post(s.base, "/v1/execute", { decisionId: d.decisionId }, bearer(t))).json()) as Json).status).toBe("simulated");
  });

  it("another account, another decision or another action is refused", async () => {
    const s = await start({ ownerAccount: "owner.near", approvals: accepts });
    close = s.close;
    const t = s.access.issue("agent-1");
    const d = (await (await post(s.base, "/v1/preflight", { intent: warn() }, bearer(t))).json()) as Json;
    expect((await post(s.base, "/v1/approve", { decisionId: d.decisionId, signed: signedFor(d.decisionId, "approve", "mallory.near") })).status).toBe(401);
    expect((await post(s.base, "/v1/approve", { decisionId: d.decisionId, signed: signedFor("another-decision") })).status).toBe(400);
    expect((await post(s.base, "/v1/approve", { decisionId: d.decisionId, signed: signedFor(d.decisionId, "reject") })).status).toBe(400);
  });

  it("the message binds what the owner was shown", async () => {
    const seen: string[] = [];
    const s = await start({ ownerAccount: "owner.near", approvals: { verify: async (_a, m) => (seen.push(m), true) } });
    close = s.close;
    const t = s.access.issue("agent-1");
    const d = (await (await post(s.base, "/v1/preflight", { intent: warn() }, bearer(t))).json()) as Json;
    const review = s.env.preflight.review(d.decisionId) as OwnerReview;
    await post(s.base, "/v1/approve", { decisionId: d.decisionId, signed: signedFor(d.decisionId) });
    expect(seen[0]).toBe(approvalMessage("approve", d.decisionId, reviewHash(review)));
    expect(reviewHash({ ...review, amount: "999" })).not.toBe(reviewHash(review));
  });

  it("the check fails closed if the chain cannot confirm the key", async () => {
    const s = await start({ ownerAccount: "owner.near", approvals: { verify: async () => Promise.reject(new Error("rpc down")) } });
    close = s.close;
    const t = s.access.issue("agent-1");
    const d = (await (await post(s.base, "/v1/preflight", { intent: warn() }, bearer(t))).json()) as Json;
    expect((await post(s.base, "/v1/approve", { decisionId: d.decisionId, signed: signedFor(d.decisionId) })).status).toBe(401);
  });
});

