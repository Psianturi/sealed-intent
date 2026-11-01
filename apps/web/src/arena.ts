import { cell, delta, LANE_NAMES, LANES, loadRun, renderScore, usd, type LaneId, type Outcome, type Run } from "./arena-data";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

async function main() {
  let run: Run;
  try {
    run = await loadRun("/replays/official");
  } catch {
    $("score").innerHTML = `<div class="lane"><h4>No recorded run</h4><p class="note">Run <code>pnpm arena:run</code> and copy the result to <code>replays/official</code>.</p></div>`;
    return;
  }
  const m = run.manifest;
  $("badges").innerHTML = [
    `<span class="badge">CHAIN: ${esc(m.chain.toUpperCase())} · SIMULATED</span>`,
    `<span class="badge">QUOTES: SIMULATED</span>`,
    `<span class="badge">TEE: SIMULATED</span>`,
    `<span class="badge real">RULES: REAL CODE</span>`,
    `<span class="badge">VICTIM: ${esc(m.victim)}</span>`,
    `<span class="badge">APPROVER: ${esc(m.approver)}</span>`,
  ].join("");
  $("run-meta").textContent = `Run ${m.runId}, recorded ${m.createdAt.slice(0, 10)}. Policy ${m.policyHash.slice(0, 12)}…, catalog ${m.catalogHash.slice(0, 12)}…, frozen before the run.`;
  $("score").innerHTML = renderScore(run);
  const n = run.outcomes.length;
  const t = run.totals;
  $("summary").textContent = `Across ${n} scenarios the no-guard agent lost ${usd(t["no-guard"].stolenCents)} to ${t["no-guard"].escaped.length} attacks and the caps-only agent ${usd(t["caps-only"].stolenCents)} to ${t["caps-only"].escaped.length}. Through Sealed Intent: ${usd(t.sealed.stolenCents)} lost to ${t.sealed.escaped.length}, ${t.sealed.legitDone} of ${t.sealed.legitTotal} legit tasks done, ${t.sealed.falseBlocks.length} false blocks.`;

  const tbody = $("scenarios").querySelector("tbody")!;
  tbody.innerHTML = run.outcomes
    .map((o) => {
      const cells = LANES.map((l) => {
        const c = cell(o, l);
        return `<td><span class="chip ${c.cls}">${esc(c.text)}</span></td>`;
      }).join("");
      const pat = o.scenario.pattern ? `<a href="${esc(o.scenario.pattern.source)}">${esc(o.scenario.pattern.incident)}</a>, ${esc(o.scenario.pattern.date)}` : `<span class="note">${esc(o.scenario.origin)}</span>`;
      return `<tr class="clickable" data-id="${esc(o.scenario.id)}"><td><strong>${esc(o.scenario.title)}</strong><br><span class="note mono">${esc(o.scenario.id)} · ${esc(o.scenario.origin)}</span></td><td>${pat}</td>${cells}<td><span class="chip sim">${esc(o.scenario.expectedSealed)}</span></td></tr>`;
    })
    .join("");
  tbody.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", () => openDrawer(run, tr.dataset.id!)));

  const escaped = run.outcomes.filter((o) => o.lanes.sealed.verdict.stolenCents > 0 || o.lanes.sealed.verdict.foreignKeys.length);
  $("escaped").innerHTML = escaped.length
    ? escaped.map((o) => `<li><strong>${esc(o.scenario.title)}</strong> (${usd(o.lanes.sealed.verdict.stolenCents)}): ${esc(o.scenario.summary)}</li>`).join("")
    : "<li>No attack moved funds to an attacker in this run.</li>";
  $("honesty").querySelector("tbody")!.innerHTML = Object.entries(m.realVsSimulated).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  $("repro").textContent = `git clone https://github.com/Psianturi/sealed-intent && cd sealed-intent\npnpm install\npnpm arena:run            # re-run the catalog on the simulated ledger\npnpm arena:verify official  # recompute this run's score from its recorded balances\n# manifest hashes: policy ${m.policyHash}\n#                  catalog ${m.catalogHash}`;

  const pick = $<HTMLSelectElement>("pick");
  pick.innerHTML = run.outcomes.map((o) => `<option value="${esc(o.scenario.id)}">${esc(o.scenario.title)}</option>`).join("");
  const featured = run.outcomes.find((o) => o.scenario.id === "S-SECOND-ACTION") ?? run.outcomes[0]!;
  pick.value = featured.scenario.id;
  const current = () => run.outcomes.find((o) => o.scenario.id === pick.value)!;
  pick.addEventListener("change", () => draw(current(), true));
  $("play").addEventListener("click", () => draw(current(), false));
  $("skip").addEventListener("click", () => draw(current(), true));
  draw(featured, true);
}

/** Vault corridor: tokens leave the vault, pass the gates, and either land with the attacker or stay home. */
function draw(o: Outcome, instant: boolean) {
  $("scenario-summary").textContent = `${o.scenario.summary}${o.scenario.cannotReplicate ? ` Not replicated: ${o.scenario.cannotReplicate}` : ""}`;
  const gates = ["Quote", "Receiver", "Action", "Budget", "Sign"];
  const laneY = (i: number) => 70 + i * 90;
  const attacks = (l: LaneId) => o.lanes[l].results.filter((r) => r.phase === "attack");
  const svg = `<svg class="corridor" viewBox="0 0 760 320" role="img" aria-label="${esc(o.scenario.title)}: what each lane did">
    <text x="16" y="28" font-size="14" font-weight="600" fill="var(--ink)">${esc(o.scenario.title)}</text>
    <text x="16" y="46" font-size="11" fill="var(--muted)">${esc(o.scenario.pattern ? `pattern from ${o.scenario.pattern.incident}, ${o.scenario.pattern.date}` : o.scenario.origin)}</text>
    ${LANES.map((l, i) => {
      const y = laneY(i);
      const v = o.lanes[l].verdict;
      const label = v.stolenCents > 0 ? `lost ${usd(v.stolenCents)}` : v.foreignKeys.length ? "attacker key added" : cell(o, l).text;
      const gateMarks = l === "sealed" ? gates.map((g, k) => `<rect x="${250 + k * 70 - 2}" y="${y - 16}" width="4" height="32" rx="2" fill="var(--line)" data-gate="${k}"/><text x="${250 + k * 70}" y="${y + 30}" font-size="10" text-anchor="middle" fill="var(--muted)">${g}</text>`).join("") : l === "caps-only" ? `<rect x="${250 + 3 * 70 - 2}" y="${y - 16}" width="4" height="32" rx="2" fill="var(--line)" data-gate="3"/><text x="${250 + 3 * 70}" y="${y + 30}" font-size="10" text-anchor="middle" fill="var(--muted)">Caps</text>` : "";
      return `<g data-lane="${l}">
        <text x="16" y="${y - 24}" font-size="12" font-weight="600" fill="var(--ink)">${LANE_NAMES[l]}</text>
        <rect x="120" y="${y - 18}" width="56" height="36" rx="6" fill="none" stroke="var(--line)"/><text x="148" y="${y + 4}" font-size="11" text-anchor="middle" fill="var(--muted)">Vault</text>
        <line x1="176" y1="${y}" x2="600" y2="${y}" stroke="var(--line)" stroke-width="2"/>
        ${gateMarks}
        <rect x="600" y="${y - 18}" width="80" height="36" rx="6" fill="var(--attacker-soft)" stroke="var(--attacker)"/><text x="640" y="${y + 4}" font-size="11" text-anchor="middle" fill="var(--ink)">Attacker</text>
        <text x="690" y="${y + 4}" font-size="11" fill="var(--ink)" data-label="${l}">${instant ? esc(label) : ""}</text>
        <g data-tokens="${l}"></g>
      </g>`;
    }).join("")}
  </svg>`;
  $("corridor").innerHTML = svg;
  if (instant || reduced) {
    for (const l of LANES) {
      const v = o.lanes[l].verdict;
      const a = attacks(l);
      const stopped = a.some((r) => r.verdict === "BLOCK" || (r.verdict === "WARN" && !r.executed));
      const gateIndex = l === "sealed" ? gateFor(a) : 3;
      const g = $("corridor").querySelector(`[data-lane="${l}"] [data-gate="${gateIndex}"]`);
      if (g && stopped) g.setAttribute("fill", "var(--block)");
      if (v.stolenCents > 0 || v.foreignKeys.length) $("corridor").querySelector(`[data-lane="${l}"] rect[fill="var(--attacker-soft)"]`)?.setAttribute("stroke-width", "3");
    }
    return;
  }
  LANES.forEach((l, i) => animateLane(o, l, laneY(i), attacks(l)));
}

function gateFor(results: { codes: string[]; verdict: string }[]): number {
  const codes = results.flatMap((r) => r.codes);
  if (codes.some((c) => /QUOTE|ASSET|VALUE_LOSS|DRIFT/.test(c))) return 0;
  if (codes.some((c) => /COUNTERPARTY|RECIPIENT|INJECTION/.test(c))) return 1;
  if (codes.some((c) => /ACTION_CLASS|METHOD|CONTRACT|FROZEN/.test(c))) return 2;
  if (codes.some((c) => /BUDGET|PER_TX/.test(c))) return 3;
  return 4;
}

function animateLane(o: Outcome, l: LaneId, y: number, attacks: { verdict: string; executed: boolean; codes: string[] }[]) {
  const host = $("corridor").querySelector(`[data-lane="${l}"]`)!;
  const tokens = host.querySelector(`[data-tokens="${l}"]`)!;
  const label = host.querySelector(`[data-label="${l}"]`)!;
  const v = o.lanes[l].verdict;
  const stopped = attacks.some((r) => r.verdict === "BLOCK" || (r.verdict === "WARN" && !r.executed));
  const gateIndex = l === "sealed" ? gateFor(attacks) : l === "caps-only" && stopped ? 3 : -1;
  const gateX = gateIndex >= 0 ? 250 + gateIndex * 70 : 600;
  const token = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  token.setAttribute("width", "16");
  token.setAttribute("height", "16");
  token.setAttribute("rx", "3");
  token.setAttribute("y", String(y - 8));
  token.setAttribute("x", "180");
  token.setAttribute("fill", "var(--warn)");
  tokens.appendChild(token);
  const travel = (stopped ? gateX - 14 : 600) - 180;
  const anim = token.animate([{ transform: "translateX(0px)" }, { transform: `translateX(${travel}px)` }], { duration: 900 + travel, easing: "linear", fill: "forwards" });
  anim.onfinish = () => {
    if (stopped) {
      host.querySelector(`[data-gate="${gateIndex}"]`)?.setAttribute("fill", "var(--block)");
      token.animate([{ transform: `translateX(${travel}px)` }, { transform: `translateX(${travel - 40}px)` }], { duration: 300, fill: "forwards", easing: "ease-out" });
      token.setAttribute("fill", "var(--allow)");
    } else {
      token.setAttribute("fill", "var(--block)");
      host.querySelector(`rect[fill="var(--attacker-soft)"]`)?.setAttribute("stroke-width", "3");
    }
    label.textContent = v.stolenCents > 0 ? `lost ${usd(v.stolenCents)}` : v.foreignKeys.length ? "attacker key added" : cell(o, l).text;
  };
}

function openDrawer(run: Run, id: string) {
  const o = run.outcomes.find((x) => x.scenario.id === id)!;
  const d = $("drawer");
  const changes = LANES.map((l) => {
    const rows = delta(o, l, run.manifest.prices)
      .slice(0, 6)
      .map((c) => `<li class="mono">${esc(c.account)}: ${c.change >= 0 ? "+" : ""}${c.change.toFixed(2)} USD</li>`)
      .join("");
    return `<h4>${LANE_NAMES[l]}: ${esc(cell(o, l).text)}</h4><ul>${rows || "<li class='note'>no balance changed</li>"}</ul>`;
  }).join("");
  const events = o.events
    .map((e) => `<li><span class="who">${esc(e.lane)} · ${esc(e.type)}</span>${esc(e.summary)}</li>`)
    .join("");
  d.innerHTML = `<button class="btn close" id="close">Close</button>
    <h3>${esc(o.scenario.title)}</h3>
    <p>${esc(o.scenario.summary)}</p>
    ${o.scenario.pattern ? `<p class="note">Pattern from <a href="${esc(o.scenario.pattern.source)}">${esc(o.scenario.pattern.incident)}</a>, ${esc(o.scenario.pattern.date)}. Origin: ${esc(o.scenario.origin)}.</p>` : ""}
    ${o.scenario.cannotReplicate ? `<p class="note honest">Not replicated: ${esc(o.scenario.cannotReplicate)}</p>` : ""}
    <h3>Evidence: balance changes per lane</h3>${changes}
    <h3>What happened</h3><ul class="events">${events}</ul>
    <h3>Raw</h3><details><summary>outcome JSON</summary><pre class="mono" style="font-size:11px;white-space:pre-wrap">${esc(JSON.stringify({ scenario: o.scenario, lanes: o.lanes }, null, 1))}</pre></details>`;
  d.classList.add("open");
  d.setAttribute("aria-hidden", "false");
  $("close").addEventListener("click", () => {
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const d = $("drawer");
    d.classList.remove("open");
    d.setAttribute("aria-hidden", "true");
  }
});

main();
