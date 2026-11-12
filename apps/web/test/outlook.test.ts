import { describe, expect, it } from "vitest";
import { scan, type AccessKey, type ScanInput } from "../src/checkup-core";
import { outlook, passesFor, type Tx } from "../src/checkup-outlook";

const fullKey = (k: string): AccessKey => ({ public_key: k, access_key: { nonce: 1, permission: "FullAccess" } });
const fc = (receiver: string): AccessKey => ({ public_key: `ed25519:${receiver}`, access_key: { nonce: 1, permission: { FunctionCall: { allowance: "250000000000000000000000", receiver_id: receiver, method_names: [] } } } });
const base: ScanInput = { network: "mainnet", account: "alice.near", exists: true, codeHash: "11111111111111111111111111111111", keys: [fullKey("ed25519:a")], missing: [], tokens: [], nfts: [], pools: [], contacts: [], flagged: [] };
const now = Date.now();
const pay = (to: string, near = "1000000000000000000000000"): Tx => ({ signer: "alice.near", receiver: to, actions: [{ action: "TRANSFER" }], deposit: near, time: now, ok: true });
const got = (from: string, near = "1000000000000000000000000"): Tx => ({ signer: from, receiver: "alice.near", actions: [{ action: "TRANSFER" }], deposit: near, time: now, ok: true });
const call = (to: string, method: string): Tx => ({ signer: "alice.near", receiver: to, actions: [{ action: "FUNCTION_CALL", method }], deposit: "0", time: now, ok: true });
const read = (input: ScanInput, txs: Tx[], agent = false) => outlook(input, scan(input), txs, { agent });
const lane = (o: ReturnType<typeof read>, id: string) => o.lanes.find((l) => l.id === id)!;

describe("risk outlook", () => {
  it("finds nothing to warn about in a quiet wallet, and says it is not a promise", () => {
    const o = read(base, [pay("bob-the-builder.near"), got("bob-the-builder.near")]);
    expect(o.lanes.map((l) => l.level)).toEqual(["low", "low", "low"]);
    expect(o.headline).toBe("No warning signs in its public history.");
    expect(o.basis).toContain("not a promise");
  });

  it("calls out a sender whose name passes for an account the wallet has paid", () => {
    const o = read(base, [pay("bob-the-builder.near"), got("bob-the-bui1der.near", "1")]);
    expect(lane(o, "steered").level).toBe("high");
    expect(lane(o, "steered").reasons[0]).toContain("bob-the-bui1der.near");
    expect(lane(o, "steered").reasons[0]).toContain("bob-the-builder.near");
    expect(o.headline).toBe("Most exposed to: being steered to the wrong account.");
  });

  it("matches implicit accounts by their first and last characters, the way people read them", () => {
    const real = "a1b2" + "0".repeat(56) + "c3d4";
    expect(passesFor("a1b2" + "f".repeat(56) + "c3d4", [real])).toBe(real);
    expect(passesFor("ffff" + "0".repeat(56) + "c3d4", [real])).toBeUndefined();
    expect(passesFor("pay.bob.near", ["bob.near"])).toBeUndefined();
  });

  it("raises planted dust without calling it an attack", () => {
    const o = read(base, [pay("bob-the-builder.near"), got("stranger-one.near", "1000")]);
    expect(lane(o, "steered").level).toBe("elevated");
    expect(lane(o, "steered").reasons.join(" ")).toContain("1 tiny transfer");
  });

  it("reads keys: a connection to a look-alike is high, three full-access keys is elevated", () => {
    expect(lane(read({ ...base, keys: [fullKey("ed25519:a"), fc("wrap-near.near")] }, []), "keys").level).toBe("high");
    expect(lane(read({ ...base, keys: [fullKey("ed25519:a"), fullKey("ed25519:b"), fullKey("ed25519:c")] }, []), "keys").level).toBe("elevated");
  });

  it("reads partners: lure contracts and one-off receivers, with advice that fits an agent", () => {
    const lure = read(base, [call("free-claim-now.near", "claim_reward")]);
    expect(lane(lure, "partners").level).toBe("elevated");
    const spread = read(base, ["a1", "b2", "c3", "d4", "e5"].map((n) => pay(`receiver-${n}.near`)), true);
    expect(lane(spread, "partners").level).toBe("elevated");
    expect(lane(spread, "partners").reasons.join(" ")).toContain("5 of 5 receivers were paid only once");
    expect(lane(spread, "partners").action).toContain("SeIn");
    const known = read(base, [call("wrap.near", "near_deposit"), pay("bob-the-builder.near"), pay("bob-the-builder.near")]);
    expect(lane(known, "partners").level).toBe("low");
  });
});
