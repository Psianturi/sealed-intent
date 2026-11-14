import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("an agent that reaches SeIn only through MCP", () => {
  it("pays an invoice, waits for the owner, cannot approve itself, and is refused a trick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sein-mcp-test-"));
    const out = join(dir, "run.json");
    try {
      // no model key reaches the agent, so it uses the scripted brain
      const { AGENT_MODEL_KEY: _key, ...env } = process.env;
      await run(process.execPath, [join("examples", "mcp-agent.mjs"), "--brain", "scripted", "--out", out], { env, timeout: 90_000 });
      const report = JSON.parse(readFileSync(out, "utf8")) as { tools: string[]; messages: { outcome: string; ok: boolean; calls: { tool: string; result: Record<string, unknown> }[] }[] };
      expect(report.tools).toEqual(expect.arrayContaining(["pay", "finish_payment", "get_receipt"]));
      // approving is the owner's act: no tool offers it
      expect(report.tools.some((t) => /approve/i.test(t))).toBe(false);
      expect(report.messages.map((m) => m.outcome)).toEqual(["paid", "waiting", "waiting", "refused"]);
      expect(report.messages.every((m) => m.ok)).toBe(true);
      expect(report.messages[2]!.calls[0]!.tool).toBe("finish_payment");
      const refusal = report.messages[3]!.calls[0]!.result;
      expect(refusal.reasons).toContain("PROMPT_INJECTION_SUSPECTED");
      // the agent learns that it was refused, never the owner's limits
      expect(JSON.stringify(refusal)).not.toMatch(/perTxUsd|dailyUsd|allowedRecipients/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
