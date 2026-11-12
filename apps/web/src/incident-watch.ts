// Incident watch: real incidents mapped by pattern to SeIn's checks. Separate from the recorded run.
export interface Incident {
  id: string;
  title: string;
  date: string;
  datePrecision?: "day" | "month";
  category: string;
  target: string;
  loss: { usd: number | null; status: "confirmed" | "reported" | "unknown" };
  seinCheck: string;
  sources: { url: string; publisher: string }[];
}

export const CHECKS: Record<string, string> = {
  deal: "Deal real?",
  receiver: "Who gets it?",
  action: "A payment?",
  tricked: "Tricked?",
  budget: "In budget?",
  "out-of-scope": "Beyond any guard",
};

const SHOWN = 6;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function dateText(d: string): string {
  const [y, m, day] = d.split("-");
  const mon = MONTHS[Number(m) - 1] ?? "";
  return day ? `${Number(day)} ${mon} ${y}` : `${mon} ${y}`;
}

export function lossText(loss: Incident["loss"]): string {
  if (loss.usd == null || loss.status === "unknown") return "Loss unknown";
  const n = loss.usd;
  const v = n >= 1e9 ? `$${+(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${n}`;
  return `${v} ${loss.status}`;
}

const isHttps = (u: string) => /^https:\/\//.test(u);

export function row(i: Incident, hidden: boolean): string {
  const links = i.sources
    .filter((s) => isHttps(s.url))
    .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher)}</a>`)
    .join("");
  const status = i.loss.usd == null ? "unknown" : i.loss.status;
  return `<li class="iw-row${i.seinCheck === "out-of-scope" ? " oos" : ""}"${hidden ? " hidden" : ""}>
<p class="iw-meta"><time datetime="${esc(i.date)}">${esc(dateText(i.date))}</time><span>${esc(i.category.replace(/-/g, " "))}</span></p>
<h4>${esc(i.title)}</h4>
<p class="iw-target">${esc(i.target)}</p>
<p class="iw-facts"><span class="iw-loss ${esc(status)}">${esc(lossText(i.loss))}</span><span class="chip iw-check" title="Matching SeIn check, by pattern only">${esc(CHECKS[i.seinCheck] ?? "")}</span></p>
<p class="iw-src">Sources: ${links}</p>
</li>`;
}

export function render(list: Incident[]): string {
  const sorted = [...list].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const rows = sorted.map((i, n) => row(i, n >= SHOWN)).join("");
  const more = sorted.length > SHOWN ? `<button type="button" class="iw-more" aria-expanded="false" aria-controls="iw-rows">Show all ${sorted.length}</button>` : "";
  return `<ul class="iw-list" id="iw-rows">${rows}</ul>${more}`;
}

async function mount(): Promise<void> {
  const box = document.getElementById("iw-list");
  if (!box) return;
  try {
    const res = await fetch("/threats/incidents.json");
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { incidents?: Incident[] };
    box.innerHTML = render(data.incidents ?? []);
  } catch {
    box.innerHTML = `<p class="note">The incident list could not be loaded.</p>`;
    return;
  }
  const btn = box.querySelector<HTMLButtonElement>(".iw-more");
  btn?.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    const rows = box.querySelectorAll<HTMLElement>(".iw-row");
    rows.forEach((el, n) => (el.hidden = !open && n >= SHOWN));
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Show fewer" : `Show all ${rows.length}`;
  });
}

if (typeof document !== "undefined") void mount();
