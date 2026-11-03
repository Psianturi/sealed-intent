import { esc } from "./arena-data";
import { reason } from "./copy";
import { chainChecks, formatAmount, type ChainInput, type Opened } from "./verify-chain";
import { matchesSeal, verifyExecution, verifyReceipt, type Check } from "./verify-core";

interface PublicIndex { network: string; registry: string; receipts: { decisionId: string; executionReceiptId?: string }[] }
let publicIndex: PublicIndex | undefined;
const indexOf = async () => (publicIndex ??= await fetch("/receipts/index.json").then((r) => (r.ok ? (r.json() as Promise<PublicIndex>) : undefined)).catch(() => undefined));
const fetchJson = (path: string) => fetch(path).then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : undefined)).catch(() => undefined);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const FIELD: Record<string, string> = {
  amountIn: "Amount", recipient: "Receiver", taskText: "Instruction", tokenIn: "Token paid", tokenOut: "Token received", minAmountOut: "Minimum received",
  refundTo: "Refund account", depositAddress: "Deposit address", agentId: "Agent", contract: "Contract", method: "Method", args: "Arguments", details: "Details", intent: "Whole request", limitDetail: "Which limit",
};
const icon = (ok: Check["ok"]) => (ok === true ? "✓" : ok === false ? "✕" : "–");

let current: Record<string, any> | undefined;
let original: string | undefined;
let disclosure: Record<string, any> | undefined;
let isSample = false;
let openedFields: Opened[] = [];

/** What to show for a sealed field: only a value that matches its seal in this receipt. */
function shownValue(r: Record<string, any>, field: string): string | undefined {
  const candidates = [...openedFields, ...(disclosure ? [disclosure as unknown as Opened] : [])] as (Opened & { receiptId?: string; opening: { value: unknown; salt?: string } })[];
  const d = candidates.find((o) => o.field === field && (!o.receiptId || o.receiptId === r.receiptId));
  if (!d || !matchesSeal(r.commitments?.[field], d.opening)) return undefined;
  if (field === "amountIn") return formatAmount(String(d.opening.value), candidates.find((o) => o.field === "tokenIn")?.opening.value as string | undefined);
  if (field === "tokenIn") return d.opening.value === "native" ? "NEAR" : String(d.opening.value).replace("nep141:", "");
  return typeof d.opening.value === "string" ? d.opening.value : JSON.stringify(d.opening.value);
}
let chainRun = 0;

/** Fills the on-chain part after the page has already shown what the browser can prove alone. */
async function fillChain(r: Record<string, any>) {
  const run = ++chainRun;
  const box = document.getElementById("chain-checks");
  if (!box) return;
  const index = await indexOf();
  const network = r.public?.network ?? r.network;
  if (!index || !network || network !== index.network) {
    box.innerHTML = network ? "" : `<p class="note">This receipt came from a run with no transaction, so there is nothing to look up on a chain.</p>`;
    return;
  }
  box.innerHTML = `<p class="note">Reading the chain…</p>`;
  const decisionId = r.version === "sealed-intent/execution@1" ? r.decisionId : r.receiptId;
  const decision = r.version === "sealed-intent/execution@1" ? await fetchJson(`/receipts/${decisionId}.json`) : r;
  if (!decision) {
    box.innerHTML = "";
    return;
  }
  const row = index.receipts.find((x) => x.decisionId === decisionId);
  const execution = row?.executionReceiptId ? await fetchJson(`/receipts/${row.executionReceiptId}.json`) : undefined;
  const input: ChainInput = { receipt: decision, execution, proof: await fetchJson(`/proofs/${decisionId}.json`), executionProof: row?.executionReceiptId ? await fetchJson(`/proofs/${row.executionReceiptId}.json`) : undefined, opened: openedFields, registry: index.registry, network: index.network };
  const checks = await chainChecks(input);
  if (run !== chainRun) return;
  box.innerHTML = `<h3>Checked against the chain <span class="status ${index.network === "mainnet" ? "live" : "sim"}">${esc(index.network)}</span></h3><ul class="check-list chain">${checks
    .map((c) => `<li class="${c.ok === true ? "yes" : c.ok === false ? "no" : "maybe"}"><span class="mono">${icon(c.ok)}</span> <span>${esc(c.name)}${c.detail ? ` <span class="note">${esc(c.detail)}</span>` : ""}${c.link ? ` <a href="${esc(c.link)}" rel="noopener">See it on the explorer</a>` : ""}</span></li>`)
    .join("")}</ul>${execution?.txHash ? `<p class="note">A transaction is public. Following its link shows its amount and receiver, even though this page keeps them sealed.</p>` : ""}`;
}

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
  const sealedRows = commitments
    .map((f) => {
      const shown = shownValue(r, f);
      return `<div><dt>${esc(FIELD[f] ?? f)}</dt><dd>${shown !== undefined ? `<span class="mono">${esc(shown)}</span> <span class="chip allow">✓ matches the seal</span>` : `<span class="seal">sealed</span>`}</dd></div>`;
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
    <div id="chain-checks"></div>
    <details><summary>Every check</summary><ul class="check-list">${plainChecks.map((c) => `<li><span class="mono">${icon(c.ok)}</span> ${esc(c.name)}${c.detail ? ` <span class="note">${esc(c.detail)}</span>` : ""}</li>`).join("")}</ul>
    ${recorded.length ? `<p class="note">Recorded at decision time:</p><ul class="check-list">${recorded.map((c) => `<li><span class="mono">${icon(c.ok)}</span> ${esc(c.name.trim())}</li>`).join("")}</ul>` : ""}</details>
  </article>`;
  $("try-more").hidden = !isSample;
  if (res.valid) void fillChain(r);
  else chainRun++;
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
  openedFields = [];
  if (res.ok) load(await res.text(), true);
});
$("go").addEventListener("click", () => load($<HTMLTextAreaElement>("json").value));
$("open-field").addEventListener("click", async () => {
  const opened = await Promise.all(["tokenIn", "amountIn", "recipient"].map((f) => fetchJson(`/samples/disclosure-${f}.json`)));
  if (!opened.every(Boolean)) return;
  disclosure = opened[1];
  openedFields = opened;
  current = JSON.parse(original!);
  render("The owner opened the amount and the receiver. They match the seals and the real transaction. Everything else stays sealed.");
});
$("tamper").addEventListener("click", () => {
  const r = JSON.parse(original!) as Record<string, any>;
  r.verdict = r.verdict === "ALLOW" ? "BLOCK" : "ALLOW";
  disclosure = undefined;
  openedFields = [];
  current = r;
  render(`Someone changed the verdict to ${r.verdict}. The signature no longer matches.`);
});
$("reset").addEventListener("click", () => {
  disclosure = undefined;
  openedFields = [];
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

// a link to one receipt: /r/<id>
const linked = location.pathname.match(/\/r\/([0-9a-f-]{36})/)?.[1] ?? new URLSearchParams(location.search).get("r");
if (linked) {
  void fetch(`/receipts/${linked}.json`).then(async (res) => {
    if (res.ok && res.headers.get("content-type")?.includes("json")) load(await res.text());
    else $("out").innerHTML = `<article class="result bad"><p class="result-head"><span class="result-icon" aria-hidden="true">✕</span>Receipt not found</p><p>This site has no receipt with that id.</p></article>`;
  });
}
