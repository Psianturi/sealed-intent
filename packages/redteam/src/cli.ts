#!/usr/bin/env tsx
/** pnpm redteam  -> runs every attack scenario offline and writes out/redteam-report.{md,json} */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toMarkdown, toTable } from "./report";
import { defaultDirs, runScenarios } from "./scenarios";

const dirs = defaultDirs();
const results = await runScenarios(dirs);
console.log(toTable(results));
for (const r of results.filter((x) => x.note)) console.log(`\n${r.title}: ${r.note}`);
mkdirSync(dirs.outDir, { recursive: true });
writeFileSync(join(dirs.outDir, "redteam-report.json"), JSON.stringify(results, null, 2));
writeFileSync(join(dirs.outDir, "redteam-report.md"), toMarkdown(results));
const passed = results.filter((r) => r.pass).length;
console.log(`\nScore ${passed}/${results.length}. Report: out/redteam-report.md. Verify receipts: pnpm verify out/receipts`);
process.exit(passed === results.length ? 0 : 1);
