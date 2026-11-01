import { describe, expect, it, vi } from "vitest";
import { classifyCustodyReply, Reconciler, type OutgoingSource } from "../src";

const source = (list: () => string[], name = "log"): OutgoingSource => ({ name, list: async () => list() });
const setup = (txs: string[], nonce = { value: 100n }) => {
  const onMismatch = vi.fn();
  const r = new Reconciler(":memory:", { account: "wallet.testnet", sources: [source(() => txs)], nonce: { nonce: async () => nonce.value }, onMismatch });
  return { r, onMismatch, nonce };
};

describe("reconciliation", () => {
  it("accepts existing history as the starting point", async () => {
    const { r, onMismatch } = setup(["old1", "old2"]);
    expect((await r.tick()).status).toBe("baseline");
    expect((await r.tick()).status).toBe("ok");
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it("a transaction SeIn sent is not a finding", async () => {
    const txs = ["old"];
    const { r, onMismatch, nonce } = setup(txs);
    await r.tick();
    r.begin("d1");
    txs.push("tx1");
    nonce.value += 1n;
    r.end("d1", ["tx1"]);
    expect((await r.tick()).status).toBe("ok");
    expect(onMismatch).not.toHaveBeenCalled();
  });

  it("a transaction with no receipt is a finding", async () => {
    const txs = ["old"];
    const { r, onMismatch, nonce } = setup(txs);
    await r.tick();
    txs.push("sneaky");
    nonce.value += 1n;
    const result = await r.tick();
    expect(result.status).toBe("mismatch");
    expect(onMismatch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ unknownTx: ["sneaky"], uncountedByNonce: 1 });
  });

  it("the nonce catches a transaction that no log lists", async () => {
    const { r, nonce } = setup(["old"]);
    await r.tick();
    nonce.value += 1n;
    expect(await r.tick()).toMatchObject({ status: "mismatch", unknownTx: [], uncountedByNonce: 1 });
  });

  it("a storage registration and its payment count as one decision", async () => {
    const txs = ["old"];
    const { r, nonce } = setup(txs);
    await r.tick();
    r.begin("d1");
    txs.push("storage", "payment");
    nonce.value += 2n;
    r.end("d1", ["storage", "payment"]);
    expect((await r.tick()).status).toBe("ok");
  });

  it("waits while a payment is in flight, but not forever", async () => {
    const txs = ["old"];
    const { r, nonce } = setup(txs);
    const t0 = Date.now();
    await r.tick(t0);
    r.begin("d1", t0);
    txs.push("tx1");
    nonce.value += 1n;
    expect((await r.tick(t0 + 5_000)).status).toBe("deferred");
    expect((await r.tick(t0 + 4 * 60_000)).status).toBe("mismatch");
  });

  it("silence from every source is not an all clear", async () => {
    const r = new Reconciler(":memory:", { account: "w", sources: [{ name: "down", list: async () => Promise.reject(new Error("down")) }], onMismatch: vi.fn() });
    expect((await r.tick()).status).toBe("unavailable");
  });

  it("after the owner accepts, the same history is quiet and a new one is not", async () => {
    const txs = ["old"];
    const { r, nonce } = setup(txs);
    await r.tick();
    txs.push("sneaky");
    nonce.value += 1n;
    expect((await r.tick()).status).toBe("mismatch");
    expect(await r.accept()).toBe(true);
    expect((await r.tick()).status).toBe("ok");
    txs.push("again");
    nonce.value += 1n;
    expect((await r.tick()).status).toBe("mismatch");
  });
});

describe("reading what custody answered", () => {
  it("a policy refusal means nothing was signed", () => {
    expect(classifyCustodyReply({ http: 403, body: { error: "policy_denied", message: "not in whitelist" } })).toMatchObject({ status: "not_sent", refusedByCustody: true });
    expect(classifyCustodyReply({ http: 403, body: { error: "wallet_frozen" } })).toMatchObject({ status: "not_sent", refusedByCustody: true });
  });

  it("busy, limits and bad requests mean nothing was signed", () => {
    for (const http of [400, 401, 409, 429]) expect(classifyCustodyReply({ http, body: { error: "x" } }).status).toBe("not_sent");
  });

  it("a chain failure keeps the real hash", () => {
    expect(classifyCustodyReply({ http: 422, body: { error: "onchain_tx_failed", tx_hash: "h" } })).toMatchObject({ status: "failed_on_chain", txHash: "h", txHashes: ["h"] });
    expect(classifyCustodyReply({ http: 200, body: { status: "failed", tx_hash: "h" } })).toMatchObject({ status: "failed_on_chain", txHash: "h" });
  });

  it("success needs a hash", () => {
    expect(classifyCustodyReply({ http: 200, body: { status: "success", tx_hash: "h" } })).toMatchObject({ status: "submitted", txHash: "h" });
    expect(classifyCustodyReply({ http: 200, body: { status: "success" } }).status).toBe("unknown");
  });

  it("anything unclear is unknown, never not_sent", () => {
    expect(classifyCustodyReply({ http: 500, body: {} }).status).toBe("unknown");
    expect(classifyCustodyReply({ http: 200, body: { error: "duplicate_idempotency_key" } }).status).toBe("unknown");
    expect(classifyCustodyReply({ http: 200, body: { status: "pending_approval", approval_id: "a" } }).status).toBe("pending_approval");
  });
});
