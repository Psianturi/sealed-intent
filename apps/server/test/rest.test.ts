import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ASSET, buildPreflight, DEMO_ACCOUNTS, ReceiptStore } from "@sealed-intent/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRestServer } from "../src/rest-server";

const usdc = (d: number) => String(Math.round(d * 1e6));
const intent = (over: Record<string, unknown> = {}) => ({
  kind: "swap", tokenIn: ASSET.USDC, tokenOut: ASSET.wNEAR, amountIn: usdc(5),
  recipient: DEMO_ACCOUNTS.newVendor, refundTo: DEMO_ACCOUNTS.self, taskText: "Routine treasury task approved by ops.", ...over,
});

describe("REST server auth", () => {
  let base = "";
  let server: ReturnType<typeof createRestServer>;
  const post = (path: string, data: unknown, token?: string) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
  type Json = Record<string, any>;
  const json = async (r: Promise<Response>): Promise<Json> => (await r).json() as Promise<Json>;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-rest-"));
    const env = buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: ":memory:" });
    server = createRestServer({
      ...env,
      receipts: new ReceiptStore(join(dir, "out"), join(dir, ".sealed")),
      offline: true,
      auth: { agentForToken: (t) => (t === "agent-token" ? "agent-1" : undefined), ownerToken: "owner-secret", ownerTokenGenerated: false },
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("rejects agents without a token and ignores agentId in the body", async () => {
    expect((await post("/v1/preflight", { intent: intent() })).status).toBe(401);
    const ok = await post("/v1/preflight", { intent: intent({ agentId: "someone-else" }) }, "agent-token");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Json).verdict).toBe("WARN");
  });

  it("only the owner token can approve, and execution is tied to the agent", async () => {
    const d = await json(post("/v1/preflight", { intent: intent() }, "agent-token"));
    expect(d.verdict).toBe("WARN");
    expect((await post("/v1/approve", { decisionId: d.decisionId, approver: "me" })).status).toBe(401);
    expect((await post("/v1/approve", { decisionId: d.decisionId, approver: "me" }, "agent-token")).status).toBe(401);
    expect((await json(post("/v1/execute", { decisionId: d.decisionId }, "agent-token"))).status).toBe("not_sent");
    const approved = await post("/v1/approve", { decisionId: d.decisionId, approver: "posma" }, "owner-secret");
    expect(((await approved.json()) as Json).ok).toBe(true);
    const exec = await json(post("/v1/execute", { decisionId: d.decisionId }, "agent-token"));
    expect(exec.status).toBe("simulated");
  });

  it("the owner kill switch freezes every agent until unfreeze", async () => {
    expect((await post("/v1/freeze", { reason: "test" }, "agent-token")).status).toBe(401);
    expect((await json(post("/v1/freeze", { reason: "incident" }, "owner-secret"))).frozen).toBe(true);
    const d = await json(post("/v1/preflight", { intent: intent({ recipient: DEMO_ACCOUNTS.self }) }, "agent-token"));
    expect(d.reasonCodes).toEqual(["WALLET_FROZEN"]);
    expect((await json(post("/v1/unfreeze", {}, "owner-secret"))).frozen).toBe(false);
    expect((await json(post("/v1/preflight", { intent: intent({ recipient: DEMO_ACCOUNTS.self }) }, "agent-token"))).verdict).toBe("ALLOW");
  });
});
