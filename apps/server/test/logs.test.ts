import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ASSET, buildPreflight, DEMO_ACCOUNTS, ReceiptStore } from "@sealed-intent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestServer } from "../src/rest-server";

afterEach(() => vi.restoreAllMocks());

describe("the server's logs", () => {
  it("never carry an amount, a receiver or the instruction", async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(capture);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (lines.push(String(c)), true));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (lines.push(String(c)), true));

    const dir = mkdtempSync(join(tmpdir(), "sein-logs-"));
    const env = buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: ":memory:" });
    const server = createRestServer({ ...env, receipts: new ReceiptStore(join(dir, "out"), join(dir, ".sealed")), offline: true, auth: { agentForToken: (t) => (t === "agent" ? "log-agent" : undefined), ownerToken: "owner", ownerTokenGenerated: false } });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, data: unknown, token: string) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(data) }).then((r) => r.json() as Promise<Record<string, string>>);

    const INSTRUCTION = "Pay the secret invoice number 90210 for the board";
    const AMOUNT = "7654321";
    const allowed = await post("/v1/preflight", { intent: { kind: "transfer", token: ASSET.USDC, amount: AMOUNT, recipient: DEMO_ACCOUNTS.payroll, taskText: INSTRUCTION } }, "agent");
    await post("/v1/execute", { decisionId: allowed.decisionId }, "agent");
    const warned = await post("/v1/preflight", { intent: { kind: "transfer", token: ASSET.USDC, amount: AMOUNT, recipient: DEMO_ACCOUNTS.newVendor, taskText: INSTRUCTION } }, "agent");
    await post("/v1/approve", { decisionId: warned.decisionId, approver: "owner" }, "owner");
    await post("/v1/execute", { decisionId: warned.decisionId }, "agent");
    await post("/v1/preflight", { intent: { kind: "transfer", token: ASSET.USDC, amount: "99000000000", recipient: DEMO_ACCOUNTS.payroll, taskText: INSTRUCTION } }, "agent");
    await new Promise<void>((r) => server.close(() => r()));
    stdout.mockRestore();
    stderr.mockRestore();

    const all = lines.join("\n");
    for (const secret of [INSTRUCTION, AMOUNT, DEMO_ACCOUNTS.payroll, DEMO_ACCOUNTS.newVendor, "99000000000"]) expect(all).not.toContain(secret);
  });
});
