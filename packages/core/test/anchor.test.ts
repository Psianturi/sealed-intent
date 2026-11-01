import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { receiptLeaf, verifyMerkleProof, type ReceiptProof } from "@sealed-intent/receipt";
import { Anchorer, type AnchorChain, type AnchorRecord } from "../src";

class FakeChain implements AnchorChain {
  contract = "registry.testnet";
  network = "testnet";
  anchors: AnchorRecord[] = [];
  async latestAnchor() {
    return this.anchors.at(-1);
  }
  async anchor(root: string, from_ms: number, to_ms: number, count: number) {
    const last = this.anchors.at(-1);
    if (last && from_ms < last.to_ms) throw new Error("period overlaps the previous anchor");
    const index = this.anchors.length;
    this.anchors.push({ index, root, from_ms, to_ms, count, anchored_at_ms: to_ms + 1 });
    return { index, txHash: `tx${index}` };
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sein-anchor-"));
  mkdirSync(join(dir, "receipts"));
  const put = (id: string, at: number, extra: Record<string, unknown> = {}) => writeFileSync(join(dir, "receipts", `${id}.json`), JSON.stringify({ receiptId: id, issuedAt: new Date(at).toISOString(), ...extra }));
  const proof = (id: string) => JSON.parse(readFileSync(join(dir, "proofs", `${id}.json`), "utf8")) as ReceiptProof;
  const record = (id: string) => JSON.parse(readFileSync(join(dir, "receipts", `${id}.json`), "utf8"));
  return { dir, put, proof, record, chain: new FakeChain() };
}

describe("anchoring", () => {
  it("nothing new, nothing written", async () => {
    const { dir, chain } = setup();
    expect((await new Anchorer(chain, dir).tick()).anchored).toBe(false);
    expect(chain.anchors).toHaveLength(0);
  });

  it("every receipt in a batch proves into the root on chain", async () => {
    const { dir, chain, put, proof, record } = setup();
    for (let i = 0; i < 5; i++) put(`r${i}`, 1_000 + i);
    const r = await new Anchorer(chain, dir).tick(100_000);
    expect(r).toMatchObject({ anchored: true, index: 0, count: 5 });
    for (let i = 0; i < 5; i++) {
      const p = proof(`r${i}`);
      expect(p.leaf).toBe(receiptLeaf(record(`r${i}`)));
      expect(verifyMerkleProof(p.leaf, p.path, chain.anchors[0]!.root)).toBe(true);
    }
  });

  it("the period covers exactly the receipts inside", async () => {
    const { dir, chain, put } = setup();
    put("a", 2_000);
    put("b", 3_000);
    await new Anchorer(chain, dir).tick(100_000);
    expect(chain.anchors[0]).toMatchObject({ from_ms: 2_000, to_ms: 3_000, count: 2 });
  });

  it("a receipt just written waits for the next round", async () => {
    const { dir, chain, put } = setup();
    put("old", 1_000);
    put("new", 99_000);
    const anchorer = new Anchorer(chain, dir, 5_000);
    expect((await anchorer.tick(100_000)).count).toBe(1);
    expect((await anchorer.tick(110_000)).count).toBe(1);
    expect(chain.anchors).toHaveLength(2);
  });

  it("a round anchors only what is new", async () => {
    const { dir, chain, put } = setup();
    put("a", 1_000);
    const anchorer = new Anchorer(chain, dir);
    await anchorer.tick(100_000);
    expect((await anchorer.tick(200_000)).anchored).toBe(false);
    put("b", 150_000);
    expect((await anchorer.tick(200_000)).count).toBe(1);
  });

  it("a receipt backdated into a closed period is left out, so it can never prove", async () => {
    const { dir, chain, put } = setup();
    put("a", 5_000);
    const anchorer = new Anchorer(chain, dir);
    await anchorer.tick(100_000);
    put("backdated", 4_000);
    expect((await anchorer.tick(200_000)).anchored).toBe(false);
  });

  it("execution receipts are anchored by the time they were executed", async () => {
    const { dir, chain } = setup();
    writeFileSync(join(dir, "receipts", "x.json"), JSON.stringify({ receiptId: "x", executedAt: new Date(7_000).toISOString() }));
    await new Anchorer(chain, dir).tick(100_000);
    expect(chain.anchors[0]).toMatchObject({ from_ms: 7_000, to_ms: 7_000 });
  });
});
