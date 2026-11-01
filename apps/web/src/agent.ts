import { esc } from "./arena-data";
import { view, type Agent } from "./verify-chain";

interface IndexRow { decisionId: string; verdict: string; agent?: string; issuedAt: string; status?: string }
interface PublicIndex { network: string; registry: string; receipts: IndexRow[] }

const $ = (id: string) => document.getElementById(id)!;
const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

async function main() {
  const fromPath = location.pathname.match(/\/a\/([\w.-]+)/)?.[1];
  const id = fromPath ?? new URLSearchParams(location.search).get("id") ?? "agent-1";
  const index = (await (await fetch("/receipts/index.json")).json()) as PublicIndex;
  const agent = await view<Agent | null>(index.network, index.registry, "get_agent", { agent_id: id }).catch(() => undefined);
  if (!agent) {
    $("profile").innerHTML = `<article class="result bad"><p class="result-head"><span class="result-icon" aria-hidden="true">✕</span>No such agent</p><p>The registry has no agent called ${esc(id)}.</p></article>`;
    return;
  }
  $("title").textContent = id;
  document.title = `${id} | SeIn`;
  const mine = index.receipts.filter((r) => r.agent === id);
  const count = (v: string) => mine.filter((r) => r.verdict === v).length;
  const last = mine.map((r) => r.issuedAt).sort().at(-1);
  const anchors = await view<number>(index.network, index.registry, "anchor_count", {}).catch(() => undefined);
  const statusClass = agent.status === "Active" ? "allow" : agent.status === "Frozen" ? "warn" : "block";
  $("profile").innerHTML = `
    <article class="result ok">
      <p><span class="chip ${statusClass}">${esc(agent.status)}</span> <span class="status sim">${esc(index.network)}, test tokens</span></p>
      <dl class="sealed-list">
        <div><dt>Owner</dt><dd class="mono">${esc(agent.owner)}</dd></div>
        <div><dt>Custody account</dt><dd class="mono breaks">${esc(agent.custody_account)}</dd></div>
        <div><dt>Registered</dt><dd>${when(agent.created_at_ms)}</dd></div>
        <div><dt>Secret policy fingerprint</dt><dd class="mono breaks">${esc(agent.policy_hash)}</dd></div>
        <div><dt>Last activity</dt><dd>${last ? esc(last.slice(0, 16).replace("T", " ")) + " UTC" : "None published"}</dd></div>
      </dl>
      <h3>Decisions published</h3>
      <div class="tally">
        <div><b>${count("ALLOW")}</b><span class="chip allow">ALLOW</span></div>
        <div><b>${count("WARN")}</b><span class="chip warn">WARN</span></div>
        <div><b>${count("BLOCK")}</b><span class="chip block">BLOCK</span></div>
      </div>
      <p class="note">${anchors === 1 ? "1 batch" : `${anchors ?? "Some"} batches`} of receipts on the chain. The fingerprint proves which policy applied without showing it.</p>
    </article>
    <h2>Check any decision yourself</h2>
    <ul class="receipt-list">${mine
      .slice()
      .reverse()
      .map((r) => `<li><a href="/r/${esc(r.decisionId)}"><span class="chip ${r.verdict === "ALLOW" ? "allow" : r.verdict === "WARN" ? "warn" : "block"}">${esc(r.verdict)}</span> <span class="note">${esc(r.issuedAt.slice(0, 16).replace("T", " "))} UTC</span>${r.status ? ` <span class="note">${esc(r.status === "submitted" ? "sent on chain" : r.status === "not_sent" ? "not sent" : r.status)}</span>` : ""}</a></li>`)
      .join("")}</ul>`;
}
void main();
