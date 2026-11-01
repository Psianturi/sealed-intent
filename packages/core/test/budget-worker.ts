// Child process used by budget.test.ts: hammers one shared SQLite ledger.
import { BudgetLedger } from "../src/budget";

const [dbPath, countStr, centsStr] = process.argv.slice(2);
const ledger = new BudgetLedger(dbPath!);
let ok = 0;
for (let i = 0; i < Number(countStr); i++) {
  const r = ledger.reserve("agent-1", Number(centsStr), { hourlyCents: 1_000_000, dailyCents: 10_000 });
  if (r.ok) ok++;
}
ledger.close();
process.stdout.write(String(ok));
