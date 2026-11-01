import { verifyExecution, verifyReceipt, type Check } from "./verify-core";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let disclosure: Record<string, any> | undefined;

$<HTMLInputElement>("file").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) $<HTMLTextAreaElement>("json").value = await f.text();
});
$<HTMLInputElement>("disclosure").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) disclosure = JSON.parse(await f.text());
});
$("sample").addEventListener("click", async () => {
  const res = await fetch("/samples/receipt.json");
  $<HTMLTextAreaElement>("json").value = res.ok ? await res.text() : "(no sample available in this build)";
});
$("go").addEventListener("click", () => {
  const out = $("out");
  let r: Record<string, any>;
  try {
    r = JSON.parse($<HTMLTextAreaElement>("json").value);
  } catch {
    out.innerHTML = `<div class="result bad">Not valid JSON.</div>`;
    return;
  }
  const trusted = $<HTMLInputElement>("trust").value.trim();
  const res = r.version === "sealed-intent/execution@1" ? verifyExecution(r, trusted) : verifyReceipt(r, trusted, disclosure);
  const icon = (ok: Check["ok"]) => (ok === true ? "✓" : ok === false ? "✗" : "–");
  out.innerHTML = `<div class="result ${res.valid ? "ok" : "bad"}"><strong>${res.valid ? "VALID" : "INVALID"}</strong> ${r.verdict ? `· verdict ${r.verdict} · codes ${(r.reasonCodes ?? []).join(", ") || "none"}` : ""}<ul class="checks">${res.checks.map((c) => `<li><span class="mono">${icon(c.ok)}</span> ${c.name}${c.detail ? ` <span class="note">(${c.detail})</span>` : ""}</li>`).join("")}</ul></div>`;
});
