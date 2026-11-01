import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical";

/**
 * Receipts are bundled into a Merkle tree and only the root goes on chain, so a receipt cannot be
 * edited or created later without anyone seeing it, and the chain learns nothing about its content.
 * Prefixes keep a leaf from ever passing as a node. The browser verifier repeats this exactly.
 */
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const node = (left: string, right: string) => sha(`sein-node:${left}${right}`);

export const receiptLeaf = (record: unknown): string => sha(`sein-leaf:${canonicalJson(record)}`);

export interface ProofStep {
  side: "left" | "right";
  hash: string;
}

function levels(leaves: string[]): string[][] {
  if (leaves.length === 0) throw new Error("no leaves");
  const out = [leaves];
  while (out[out.length - 1]!.length > 1) {
    const cur = out[out.length - 1]!;
    const next: string[] = [];
    // an odd node moves up as it is, so it cannot be duplicated into a second valid tree
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? node(cur[i]!, cur[i + 1]!) : cur[i]!);
    out.push(next);
  }
  return out;
}

export const merkleRoot = (leaves: string[]): string => levels(leaves).at(-1)![0]!;

export function merkleProof(leaves: string[], index: number): ProofStep[] {
  const path: ProofStep[] = [];
  let i = index;
  for (const level of levels(leaves).slice(0, -1)) {
    const sibling = i ^ 1;
    if (sibling < level.length) path.push({ side: i % 2 ? "left" : "right", hash: level[sibling]! });
    i = Math.floor(i / 2);
  }
  return path;
}

export const verifyMerkleProof = (leaf: string, path: ProofStep[], root: string): boolean => path.reduce((h, s) => (s.side === "left" ? node(s.hash, h) : node(h, s.hash)), leaf) === root;

export interface ReceiptProof {
  version: "sein/proof@1";
  receiptId: string;
  network: string;
  registry: string;
  anchorIndex: number;
  anchorTx?: string;
  root: string;
  leaf: string;
  path: ProofStep[];
}
