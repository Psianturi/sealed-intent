// Runs as the agent's OS user inside scripts/isolation-check.sh. Every line is one thing the agent must not be able to do.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const { SEALED_REST_URL: base, SEALED_AGENT_TOKEN: token, ISO_STATE: state, ISO_PID: pid, ISO_CODE: code } = process.env;
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};
const denied = (fn) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e.code === "EACCES" || e.code === "EPERM";
  }
};
const api = (method, path, body, auth = token) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const SECRETS = ["OUTLAYER_API_KEY", "SEALED_POLICY_KEY", "SEALED_DATA_KEY", "SEALED_OWNER_TOKEN", "SEALED_AGENT_TOKENS", "NEARAI_API_KEY", "ONECLICK_JWT"];
check("no custody key, policy key or owner token in the agent's environment", SECRETS.every((k) => !process.env[k]));
check("cannot list the checker's folder", denied(() => readdirSync(state)));
check("cannot read the checker's .env", denied(() => readFileSync(join(state, ".env"))));
check("cannot read the database", denied(() => readFileSync(join(state, ".sealed", "budget.db"))));
check("cannot read private openings", denied(() => readdirSync(join(state, ".sealed", "openings"))));
check("cannot read the checker's process environment", denied(() => readFileSync(`/proc/${pid}/environ`)));
check("cannot signal the checker's process", denied(() => process.kill(Number(pid), 0)));

// without the key, the custody API itself refuses or is out of reach
let custody = "unreachable";
try {
  const res = await fetch("https://api.outlayer.ai/wallet/v1/address?chain=near", { signal: AbortSignal.timeout(8000) });
  custody = String(res.status);
} catch {
  /* no network path counts as out of reach */
}
check("the custody API gives the agent nothing without the key", !/^2/.test(custody), `HTTP ${custody}`);

const intent = { kind: "transfer", token: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", amount: "5000000", recipient: "payroll-alice.near", purpose: "payroll", taskText: "Routine treasury task approved by ops." };
check("no token: the checker refuses", (await api("POST", "/v1/preflight", { intent }, null)).status === 401);
const res = await api("POST", "/v1/preflight", { intent });
const decision = await res.json();
check("the agent's token can ask", res.status === 200 && decision.verdict === "ALLOW", decision.verdict);
check("the answer holds no private detail", !("receiptPath" in decision || "detailCodes" in decision || "metrics" in decision));
const low = await (await api("POST", "/v1/preflight", { intent: { ...intent, recipient: "fresh-vendor-2026.near" } })).json();
check("a WARN is raised for a new receiver", low.verdict === "WARN", low.verdict);

for (const [path, body] of [
  ["/v1/approve", { decisionId: low.decisionId, approver: "agent" }],
  ["/v1/reject", { decisionId: low.decisionId, approver: "agent" }],
  ["/v1/freeze", { reason: "x" }],
  ["/v1/unfreeze", {}],
  ["/v1/blocklist/confirm", { account: "x.near" }],
  ["/v1/counterparty/accept-code", { account: "x.near" }],
  ["/v1/watch/accept", { account: "x.near" }],
]) check(`the agent's token cannot call ${path}`, (await api("POST", path, body)).status === 401);
check("the agent's token cannot read the review queue", (await api("GET", "/v1/pending")).status === 401);
const exec = await (await api("POST", "/v1/execute", { decisionId: low.decisionId })).json();
check("the agent cannot execute its own WARN", exec.status === "not_sent", exec.details);
const stat = await (await api("GET", "/v1/status")).json();
check("status tells the agent nothing beyond frozen and mode", Object.keys(stat).sort().join() === "frozen,mode");

// the MCP bridge an agent host actually runs
const tsx = join(code, "node_modules", ".bin", "tsx");
const bridge = join(code, "apps", "server", "src", "mcp-agent.ts");
const refused = await new Promise((resolve) => {
  const p = spawn(tsx, [bridge], { env: { ...process.env, OUTLAYER_API_KEY: "leaked" }, stdio: "ignore" });
  p.on("exit", (c) => resolve(c));
});
check("the MCP bridge refuses to start with a secret in its environment", refused === 3, `exit ${refused}`);

const tools = await new Promise((resolve, reject) => {
  const p = spawn(tsx, [bridge], { env: process.env, stdio: ["pipe", "pipe", "inherit"] });
  let out = "";
  const send = (m) => p.stdin.write(`${JSON.stringify(m)}\n`);
  const timer = setTimeout(() => {
    p.kill();
    reject(new Error("MCP bridge timed out"));
  }, 60_000);
  p.stdout.on("data", (c) => {
    out += c;
    for (const line of out.split("\n").slice(0, -1)) {
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      }
      if (msg.id === 2) {
        clearTimeout(timer);
        p.kill();
        resolve(msg.result.tools.map((t) => t.name));
      }
    }
    out = out.slice(out.lastIndexOf("\n") + 1);
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "iso", version: "0" } } });
});
check("the MCP bridge lists the tools, and none of them approves", tools.includes("preflight_transfer") && !tools.some((t) => /approve|freeze/.test(t)), tools.join(" "));

if (failures) {
  console.log(`${failures} isolation check(s) failed`);
  process.exit(1);
}
