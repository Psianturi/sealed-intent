import { esc } from "./arena-data";
import { verifyExecution, verifyReceipt, type Check } from "./verify-core";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FIELD: Record<string, string> = {
  amountIn: "Amount", recipient: "Receiver", taskText: "Instruction", tokenIn: "Token paid", tokenOut: "Token received", minAmountOut: "Minimum received",
  refundTo: "Refund account", depositAddress: "Deposit address", agentId: "Agent", contract: "Contract", method: "Method", args: "Arguments", details: "Details", intent: "Whole request", limitDetail: "Which limit",
};
const REASON: Record<string, string> = {
  LIMIT_EXCEEDED: "A spending limit was reached", PROMPT_INJECTION_SUSPECTED: "The instruction looks like a trick", TEE_SIGNAL_BLOCK: "The enclave says it is unsafe", TEE_UNVERIFIED: "The enclave could not be verified", TEE_UNAVAILABLE: "The enclave was unavailable",
  COUNTERPARTY_BLOCKLISTED: "The receiver is on the blocklist", COUNTERPARTY_REPORTED: "Another agent reported the receiver", COUNTERPARTY_NOT_FOUND: "The receiver does not exist", COUNTERPARTY_NEW_ACCOUNT: "The receiver is a new account", COUNTERPARTY_FIRST_CONTACT: "Never paid before", COUNTERPARTY_CODE_CHANGED: "The contract's code changed", RECIPIENT_NOT_ALLOWLISTED: "The receiver is not a known partner",
  ACTION_CLASS_FORBIDDEN: "This kind of action is never allowed", WALLET_FROZEN: "The wallet is frozen", LOOKALIKE_ASSET: "A look-alike token", EXCESSIVE_VALUE_LOSS: "The route loses too much value", ROUTE_NOT_CONFIDENTIAL: "A private payment on a public route", TASK_CONTEXT_MISSING: "The instruction was not provided", RPC_DISAGREEMENT: "Data sources disagree",
};
const reason = (c: string) => REASON[c] ?? c.toLowerCase().replace(/_/g, " ").replace(/^./, (m) => m.toUpperCase());
const icon = (ok: Check["ok"]) => (ok === true ? "✓" : ok === false ? "✕" : "–");

let current: Record<string, any> | undefined;
let original: string | undefined;
let disclosure: Record<string, any> | undefined;
let isSample = false;

function render(note?: string) {
  const out = $("out");
  if (!current) return;
  const r = current;
  const trusted = $<HTMLInputElement>("trust").value.trim();
  const res = r.version === "sealed-intent/execution@1" ? verifyExecution(r, trusted) : verifyReceipt(r, trusted, disclosure);
  const verdict = r.verdict as string | undefined;
  const cls = verdict === "ALLOW" ? "allow" : verdict === "WARN" ? "warn" : "block";
  const reasons = [...(r.reasonCodes ?? []), ...(r.warnCodes ?? [])] as string[];
  const commitments = Object.keys(r.commitments ?? {});
  const opened = disclosure && res.checks.find((c) => c.name.startsWith("Opened field"));
  const sealedRows = commitments
    .map((f) => {
      const isOpen = disclosure?.field === f && opened?.ok === true;
      return `<div><dt>${esc(FIELD[f] ?? f)}</dt><dd>${isOpen ? `<span class="mono">${esc(JSON.stringify(disclosure!.opening.value))}</span> <span class="chip allow">✓ matches the seal</span>` : `<span class="seal">sealed</span>`}</dd></div>`;
    })
    .join("");
  const tee = r.tee;
  const enclave = !tee ? "" : tee.kind === "offline-simulated" ? `<p class="note">Enclave: a local stand-in, labelled as simulated. Not a real enclave.</p>` : `<p class="note">Enclave: real, on NEAR AI Cloud. Intel status ${esc(String(tee.attestation?.tcbStatus ?? "unknown"))}, ${esc(String(tee.attestation?.gpus ?? "?"))} GPUs verified${tee.attestation?.tlsBound ? ", connection tied to the evidence" : ""}.</p>`;
  const plainChecks = res.checks.filter((c) => !c.name.startsWith("  "));
  const recorded = res.checks.filter((c) => c.name.startsWith("  "));
  out.innerHTML = `<article class="result ${res.valid ? "ok" : "bad"}">
    <p class="result-head"><span class="result-icon" aria-hidden="true">${res.valid ? "✓" : "✕"}</span>${res.valid ? "Valid receipt" : "Not valid"}</p>
    ${note ? `<p class="result-note">${esc(note)}</p>` : ""}
    ${verdict ? `<p><span class="chip ${cls}">${esc(verdict)}</span> ${reasons.length ? esc(reasons.map(reason).join(". ")) + "." : "All checks passed."}</p>` : `<p>Execution of decision <code>${esc(String(r.decisionId))}</code>: ${esc(String(r.status))}${r.txHash ? `, transaction <code>${esc(String(r.txHash))}</code>` : ""}.</p>`}
    ${enclave}
    ${sealedRows ? `<h3>Sealed</h3><dl class="sealed-list">${sealedRows}</dl>` : ""}
    <details><summary>Every check</summary><ul class="check-list">${plainChecks.map((c) => `<li><span class="mono">${icon(c.ok)}</span> ${esc(c.name)}${c.detail ? ` <span class="note">${esc(c.detail)}</span>` : ""}</li>`).join("")}</ul>
    ${recorded.length ? `<p class="note">Recorded at decision time:</p><ul class="check-list">${recorded.map((c) => `<li><span class="mono">${icon(c.ok)}</span> ${esc(c.name.trim())}</li>`).join("")}</ul>` : ""}</details>
  </article>`;
  $("try-more").hidden = !isSample;
}

function load(text: string, sample = false, note?: string) {
  $<HTMLTextAreaElement>("json").value = text;
  try {
    current = JSON.parse(text);
    if (!sample) disclosure = undefined;
    isSample = sample;
    original = sample ? text : original;
    render(note);
  } catch {
    current = undefined;
    $("try-more").hidden = true;
    $("out").innerHTML = `<article class="result bad"><p class="result-head"><span class="result-icon" aria-hidden="true">✕</span>Not a receipt</p><p>This file is not valid JSON.</p></article>`;
  }
}

$<HTMLInputElement>("file").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) load(await f.text());
});
$<HTMLInputElement>("disclosure").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) disclosure = JSON.parse(await f.text());
  render();
});
$("sample").addEventListener("click", async () => {
  const res = await fetch("/samples/receipt.json");
  disclosure = undefined;
  if (res.ok) load(await res.text(), true);
});
$("go").addEventListener("click", () => load($<HTMLTextAreaElement>("json").value));
$("open-field").addEventListener("click", async () => {
  const res = await fetch("/samples/disclosure.json");
  if (!res.ok) return;
  disclosure = await res.json();
  current = JSON.parse(original!);
  render("The owner opened one field. It matches the seal, and everything else stays sealed.");
});
$("tamper").addEventListener("click", () => {
  const r = JSON.parse(original!) as Record<string, any>;
  r.verdict = r.verdict === "ALLOW" ? "BLOCK" : "ALLOW";
  disclosure = undefined;
  current = r;
  render(`Someone changed the verdict to ${r.verdict}. The signature no longer matches.`);
});
$("reset").addEventListener("click", () => {
  disclosure = undefined;
  current = JSON.parse(original!);
  render();
});

const drop = $("drop");
for (const type of ["dragenter", "dragover"]) drop.addEventListener(type, (e) => (e.preventDefault(), drop.classList.add("over")));
for (const type of ["dragleave", "drop"]) drop.addEventListener(type, () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = (e as DragEvent).dataTransfer?.files?.[0];
  if (f) load(await f.text());
});
