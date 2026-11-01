import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { BudgetLedger } from "../src/budget";

const run = promisify(execFile);

describe("BudgetLedger", () => {
  it("enforces hourly and daily caps and frees released reservations", () => {
    const ledger = new BudgetLedger(":memory:");
    const limits = { hourlyCents: 5_000, dailyCents: 7_000 };
    const a = ledger.reserve("a", 3_000, limits);
    expect(a.ok).toBe(true);
    expect(ledger.reserve("a", 3_000, limits)).toEqual({ ok: false, reason: "HOURLY_BUDGET_EXCEEDED" });
    if (a.ok) ledger.release(a.reservationId);
    const b = ledger.reserve("a", 3_000, limits);
    expect(b.ok).toBe(true);
    if (b.ok) ledger.commit(b.reservationId); // executed: counts for the whole day
    // an un-committed reservation expires after its TTL and frees its budget
    const stale = ledger.reserve("a", 1_000, limits);
    expect(stale.ok).toBe(true);
    // an hour later the hourly window is free again, but the day still counts
    const later = Date.now() + 3_700_000;
    expect(ledger.reserve("a", 3_000, limits, later).ok).toBe(true); // hour 3000, day 6000
    expect(ledger.reserve("a", 1_500, limits, later)).toEqual({ ok: false, reason: "DAILY_BUDGET_EXCEEDED" }); // day 7500 > 7000
    // other agents have their own budget
    expect(ledger.reserve("b", 3_000, limits).ok).toBe(true);
  });

  it("never exceeds the cap when 8 separate processes race for it", async () => {
    // daily cap $100.00 = 10_000 cents; 8 processes x 4 requests x $15 = $480 requested
    const db = join(mkdtempSync(join(tmpdir(), "sealed-budget-")), "budget.db");
    new BudgetLedger(db).close(); // create schema first
    const worker = join(__dirname, "budget-worker.ts");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => run(process.execPath, ["--import", "tsx", worker, db, "4", "1500"], { cwd: join(__dirname, "..", "..", "..") })),
    );
    const granted = results.reduce((sum, r) => sum + Number(r.stdout), 0);
    const ledger = new BudgetLedger(db);
    expect(granted).toBe(6); // 6 x $15 = $90 <= $100, the 7th would be $105
    expect(ledger.used("agent-1", 86_400_000)).toBe(9_000);
    ledger.close();
  });
});
