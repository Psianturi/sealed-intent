import type { ScenarioResult } from "./scenarios";

export function toTable(results: ScenarioResult[]): string {
  const rows = results.map((r) => [r.pass ? "PASS" : "FAIL", r.title, r.expected, r.verdict, r.codes.join(", ") || "-"]);
  const head = ["", "Scenario", "Expected", "Got", "Reason codes"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function toMarkdown(results: ScenarioResult[]): string {
  const passed = results.filter((r) => r.pass).length;
  const lines = [
    `# Red-team report`,
    ``,
    `Score: **${passed}/${results.length}** scenarios handled as expected. Mode: offline fixtures (no keys, no funds).`,
    ``,
    `| | Scenario | Attack | Expected | Got | Reason codes |`,
    `|---|---|---|---|---|---|`,
    ...results.map((r) => `| ${r.pass ? "✅" : "❌"} | ${r.title} | ${r.attack} | ${r.expected} | ${r.verdict} | ${r.codes.map((c) => `\`${c}\``).join(" ") || "-"} |`),
    ``,
    ...results.filter((r) => r.note).map((r) => `- **${r.title}:** ${r.note}`),
    ``,
    `Verify every receipt offline: \`pnpm verify out/receipts\``,
  ];
  return lines.join("\n");
}
