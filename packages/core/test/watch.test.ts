// S6: a key or code change that did not go through the checker still freezes the wallet.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPreflight } from "../src/config";
import { ASSET, DEMO_ACCOUNTS } from "../src/fixtures";
import { AccountWatcher, RpcAccountStateReader, type AccountState } from "../src/watch";

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "sealed-watch-"));
  const env = buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: ":memory:" });
  let state: AccountState | undefined = { keys: ["ed25519:owner"], codeHash: null };
  const watcher = new AccountWatcher(":memory:", {
    accounts: ["agent.near"],
    reader: { state: async () => state },
    onChange: (f) => env.preflight.freeze(`account watcher: ${f.account} changed`, "watcher"),
  });
  return { env, watcher, set: (s: AccountState | undefined) => (state = s) };
};

describe("account watcher", () => {
  it("an unknown key freezes the wallet within one round and the next request is refused", async () => {
    const { env, watcher, set } = setup();
    expect((await watcher.tick())[0]?.status).toBe("baseline");
    expect((await watcher.tick())[0]?.status).toBe("ok");
    set({ keys: ["ed25519:owner", "ed25519:attacker"], codeHash: null });
    expect(await watcher.tick()).toEqual([{ status: "changed", account: "agent.near", newKeys: ["ed25519:attacker"], codeChanged: false }]);
    expect(env.preflight.status().frozen).toBe(true);
    const d = await env.preflight.evaluate({ agentId: "a", intent: { kind: "transfer", token: ASSET.USDC, amount: "1000000", recipient: DEMO_ACCOUNTS.payroll, taskText: "Routine treasury task approved by ops." } });
    expect(d.reasonCodes).toEqual(["WALLET_FROZEN"]);
  });

  it("code deployed to the account freezes it too", async () => {
    const { env, watcher, set } = setup();
    await watcher.tick();
    set({ keys: ["ed25519:owner"], codeHash: "sweeper" });
    expect((await watcher.tick())[0]).toMatchObject({ status: "changed", codeChanged: true });
    expect(env.preflight.status().frozen).toBe(true);
  });

  it("a removed key is not an alarm, an unreachable chain is not a change, and accepting clears the finding", async () => {
    const { env, watcher, set } = setup();
    set({ keys: ["ed25519:owner", "ed25519:second"], codeHash: null });
    await watcher.tick();
    set({ keys: ["ed25519:owner"], codeHash: null });
    expect((await watcher.tick())[0]?.status).toBe("ok");
    set(undefined);
    expect((await watcher.tick())[0]?.status).toBe("unavailable");
    expect(env.preflight.status().frozen).toBe(false);
    set({ keys: ["ed25519:owner", "ed25519:new-laptop"], codeHash: null });
    expect((await watcher.tick())[0]?.status).toBe("changed");
    expect(await watcher.accept("agent.near")).toBe(true);
    expect((await watcher.tick())[0]?.status).toBe("ok");
  });

  it("reads keys and code from RPC", async () => {
    const rpc = (async (_url: string | URL | Request, init?: RequestInit) => {
      const t = (JSON.parse(String(init?.body)) as { params: { request_type: string } }).params.request_type;
      return new Response(JSON.stringify({ result: t === "view_account" ? { code_hash: "11111111111111111111111111111111" } : { keys: [{ public_key: "ed25519:b" }, { public_key: "ed25519:a" }] } }));
    }) as typeof fetch;
    expect(await new RpcAccountStateReader(["https://rpc"], rpc).state("x.near")).toEqual({ keys: ["ed25519:a", "ed25519:b"], codeHash: null });
  });
});
