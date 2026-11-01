import { describe, expect, it } from "vitest";
import { merkleProof, merkleRoot, receiptLeaf, verifyMerkleProof } from "../src";

const leaves = (n: number) => Array.from({ length: n }, (_, i) => receiptLeaf({ receiptId: `r${i}` }));

describe("receipt tree", () => {
  it("every receipt proves into the root, for trees of any size", () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 13, 64, 101]) {
      const l = leaves(n);
      const root = merkleRoot(l);
      l.forEach((leaf, i) => expect(verifyMerkleProof(leaf, merkleProof(l, i), root)).toBe(true));
    }
  });

  it("an edited receipt no longer proves", () => {
    const l = leaves(8);
    expect(verifyMerkleProof(receiptLeaf({ receiptId: "r3", verdict: "ALLOW" }), merkleProof(l, 3), merkleRoot(l))).toBe(false);
  });

  it("a proof for one place does not fit another", () => {
    const l = leaves(8);
    expect(verifyMerkleProof(l[2]!, merkleProof(l, 3), merkleRoot(l))).toBe(false);
  });

  it("a receipt added afterwards changes the root", () => {
    expect(merkleRoot(leaves(5))).not.toBe(merkleRoot(leaves(6)));
  });

  it("repeating the last receipt does not give the same root", () => {
    const l = leaves(3);
    expect(merkleRoot([...l, l[2]!])).not.toBe(merkleRoot(l));
  });

  it("a node cannot pass as a leaf", () => {
    const l = leaves(4);
    const pair = merkleRoot(l.slice(0, 2));
    expect(verifyMerkleProof(pair, [], merkleRoot(l))).toBe(false);
  });

  it("field order does not change a receipt", () => {
    expect(receiptLeaf({ a: 1, b: 2 })).toBe(receiptLeaf({ b: 2, a: 1 }));
  });

  it("an empty batch has no tree", () => {
    expect(() => merkleRoot([])).toThrow();
  });
});
