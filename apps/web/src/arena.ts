import { cell, delta, esc, GATES, LANE_NAMES, LANES, loadRun, renderEscaped, renderFingerprints, renderHonesty, renderMeta, renderRows, renderScore, scopeSentence, usd, type LaneId, type Outcome, type Run } from "./arena-data";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const narrow = matchMedia("(max-width: 640px)");
const SVG = "http://www.w3.org/2000/svg";

async function main() {
  const chainpick = $<HTMLSelectElement>("chainpick");
  const wanted = new URLSearchParams(location.search).get("run") ?? "official";
  chainpick.value = ["official-sandbox", "official-lazy"].includes(wanted) ? wanted : "official";
  chainpick.addEventListener("change", () => {
    location.search = `?run=${chainpick.value}`;
  });
  // the page already holds the official run; this adds the animation and the other recordings
  const run = await loadRun(`/replays/${chainpick.value}`).catch(() => undefined);
  if (!run) return;
  if (chainpick.value !== "official") {
    $("run-meta").textContent = renderMeta(run).replace(/<[^>]+>/g, "");
    $("score").innerHTML = renderScore(run);
    $("summary").textContent = scopeSentence(run);
    $("scenarios").querySelector("tbody")!.innerHTML = renderRows(run);
    $("escaped").innerHTML = renderEscaped(run);
    $("honesty").querySelector("tbody")!.innerHTML = renderHonesty(run);
    $("repro").innerHTML = renderFingerprints(run);
  }

  const tbody = $("scenarios").querySelector("tbody")!;
  tbody.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("a")) return;
    const id = target.closest<HTMLElement>("tr")?.dataset.id;
    if (id) openDrawer(run, id);
  });

  const pick = $<HTMLSelectElement>("pick");
  pick.innerHTML = run.outcomes.map((o) => `<option value="${esc(o.scenario.id)}">${esc(o.scenario.title)}</option>`).join("");
  const featured = run.outcomes.find((o) => o.scenario.id === "S-MORSE") ?? run.outcomes[0]!;
  pick.value = featured.scenario.id;
  const current = () => run.outcomes.find((o) => o.scenario.id === pick.value)!;
  pick.addEventListener("change", () => draw(current(), false));
  $("play").addEventListener("click", () => draw(current(), false));
  $("skip").addEventListener("click", () => draw(current(), true));
  narrow.addEventListener("change", () => draw(current(), true));
  draw(featured, reduced);
}

const attacksOf = (o: Outcome, l: LaneId) => o.lanes[l].results.filter((r) => r.phase === "attack");
/** The attack never asked this lane anything: it went around the checks, so they must not light up. */
const bypassed = (o: Outcome, l: LaneId) => attacksOf(o, l).length === 0;
const stoppedIn = (o: Outcome, l: LaneId) => attacksOf(o, l).some((r) => r.verdict === "BLOCK" || (r.verdict === "WARN" && !r.executed));
const labelOf = (o: Outcome, l: LaneId) => (o.lanes[l].verdict.stolenCents > 0 ? `Lost ${usd(o.lanes[l].verdict.stolenCents)}` : o.lanes[l].verdict.foreignKeys.length ? "Attacker key added" : cell(o, l).text);

/** The check that stopped it: the first stopped request, its first reason. */
function gateFor(o: Outcome, l: LaneId): number {
  const r = attacksOf(o, l).find((x) => x.verdict === "BLOCK" || (x.verdict === "WARN" && !x.executed));
  for (const c of r?.codes ?? []) {
    if (/QUOTE|ASSET|VALUE_LOSS|DRIFT|ROUTE/.test(c)) return 0;
    if (/COUNTERPARTY|RECIPIENT|RPC/.test(c)) return 1;
    if (/ACTION_CLASS|METHOD|CONTRACT|FROZEN|DEPOSIT/.test(c)) return 2;
    if (/INJECTION|TEE|TASK_CONTEXT/.test(c)) return 3;
    if (/LIMIT|BUDGET|RATE/.test(c)) return 4;
  }
  return 4;
}

function draw(o: Outcome, instant: boolean) {
  $("scenario-summary").textContent = `${o.scenario.summary}${o.scenario.pattern ? ` Pattern from ${o.scenario.pattern.incident}, ${o.scenario.pattern.date}.` : " A hypothetical pattern."}`;
  narrate(o, instant || reduced);
  if (narrow.matches) drawSteps(o, instant || reduced);
  else drawCorridor(o, instant || reduced);
}

/** Phones get one card per lane with the checks as words, so nothing is scaled down to unreadable. */
function drawSteps(o: Outcome, instant: boolean) {
  const host = $("corridor");
  host.innerHTML = `<div class="lane-steps">${LANES.map((l) => {
    const stopped = stoppedIn(o, l);
    const stop = l === "sealed" ? gateFor(o, l) : -1;
    const gates = l === "sealed" ? GATES : l === "caps-only" ? ["In budget?"] : [];
    const state = (i: number) => (bypassed(o, l) ? "" : !stopped ? "ok" : l !== "sealed" || i === stop ? "bad" : i < stop ? "ok" : "");
    const chips = gates.map((g, i) => `<span data-final="${state(i)}">${g}</span>`).join("");
    return `<article class="lane-step ${l}"><h3>${LANE_NAMES[l]} <span class="chip ${cell(o, l).cls}" data-res hidden>${esc(labelOf(o, l))}</span></h3><div class="lane-gates">${chips || `<span>No checks at all</span>`}</div></article>`;
  }).join("")}</div>`;
  const lanes = [...host.querySelectorAll<HTMLElement>(".lane-step")];
  lanes.forEach((card) => {
    const chips = [...card.querySelectorAll<HTMLElement>("[data-final]")];
    const res = card.querySelector<HTMLElement>("[data-res]")!;
    const finish = () => (res.hidden = false);
    if (instant) {
      chips.forEach((c) => c.dataset.final && c.classList.add(c.dataset.final));
      finish();
      return;
    }
    chips.forEach((c, i) => setTimeout(() => c.dataset.final && c.classList.add(c.dataset.final), 350 + i * 320));
    setTimeout(finish, 450 + chips.length * 320);
  });
}

/** Tokens leave the vault, pass the checks, and either land with the attacker or stop at a gate. */
function drawCorridor(o: Outcome, instant: boolean) {
  const laneY = (i: number) => 52 + i * 88;
  const svg = `<svg class="corridor" viewBox="0 0 760 290" role="img" aria-label="${esc(o.scenario.title)}: what happened in each lane">
    ${LANES.map((l, i) => {
      const y = laneY(i);
      const gateMarks = (l === "sealed" ? GATES : l === "caps-only" ? ["", "", "", "", "In budget?"] : [])
        .map((g, k) => (g ? `<rect x="${236 + k * 72 - 3}" y="${y - 18}" width="6" height="36" rx="3" fill="var(--line)" data-gate="${k}"/><text x="${236 + k * 72}" y="${y + 33}" font-size="11" text-anchor="middle" fill="var(--muted)">${g}</text>` : ""))
        .join("");
      return `<g data-lane="${l}">
        <text x="16" y="${y + 5}" font-size="14" font-weight="600" fill="var(--ink)">${LANE_NAMES[l]}</text>
        <rect x="110" y="${y - 18}" width="56" height="36" rx="7" fill="var(--bg)" stroke="var(--line)"/><text x="138" y="${y + 4}" font-size="12" text-anchor="middle" fill="var(--muted)">Vault</text>
        <line x1="166" y1="${y}" x2="560" y2="${y}" stroke="var(--line)" stroke-width="2"/>
        ${gateMarks}
        <rect x="560" y="${y - 18}" width="70" height="36" rx="7" fill="var(--attacker-soft)" stroke="var(--attacker)" data-sink/><text x="595" y="${y + 4}" font-size="12" text-anchor="middle" fill="var(--ink)">Attacker</text>
        <text x="640" y="${y + 4}" font-size="12.5" font-weight="600" fill="var(--ink)" data-label>${instant ? esc(labelOf(o, l)) : ""}</text>
        <g data-tokens></g>
      </g>`;
    }).join("")}
  </svg>`;
  $("corridor").innerHTML = svg;
  LANES.forEach((l, i) => animateLane(o, l, laneY(i), instant));
}

function animateLane(o: Outcome, l: LaneId, y: number, instant: boolean) {
  const host = $("corridor").querySelector(`[data-lane="${l}"]`)!;
  const stopped = stoppedIn(o, l);
  const gateIndex = l === "sealed" ? gateFor(o, l) : 4;
  const gateX = 236 + gateIndex * 72;
  const light = (color: string) => host.querySelector(`[data-gate="${gateIndex}"]`)?.setAttribute("fill", color);
  const passed = () => {
    if (bypassed(o, l)) return;
    if (l === "sealed") for (let k = 0; k < (stopped ? gateIndex : 5); k++) host.querySelector(`[data-gate="${k}"]`)?.setAttribute("fill", "var(--allow)");
    else if (l === "caps-only" && !stopped) light("var(--allow)");
  };
  const end = () => {
    passed();
    if (stopped) light("var(--block)");
    else if (o.lanes[l].verdict.stolenCents > 0 || o.lanes[l].verdict.foreignKeys.length) host.querySelector("[data-sink]")?.setAttribute("stroke-width", "3");
    host.querySelector("[data-label]")!.textContent = labelOf(o, l);
  };
  if (instant) return end();
  const token = document.createElementNS(SVG, "rect");
  for (const [k, v] of Object.entries({ width: "18", height: "18", rx: "4", y: String(y - 9), x: "170", fill: "var(--warn)" })) token.setAttribute(k, v);
  host.querySelector("[data-tokens]")!.appendChild(token);
  const travel = (stopped ? gateX - 22 : 556) - 170;
  const anim = token.animate([{ transform: "translateX(0px)" }, { transform: `translateX(${travel}px)` }], { duration: 700 + travel * 2.2, easing: "cubic-bezier(.45,.05,.55,.95)", fill: "forwards" });
  anim.onfinish = () => {
    end();
    if (stopped) {
      token.setAttribute("fill", "var(--allow)");
      token.animate([{ transform: `translateX(${travel}px)` }, { transform: "translateX(0px)" }], { duration: 650, fill: "forwards", easing: "ease-out" });
    } else token.setAttribute("fill", "var(--block)");
  };
}

/** Plain-language steps, lit one by one while the animation runs. */
function narrate(o: Outcome, instant: boolean) {
  const steps = o.events
    .filter((e) => e.type !== "decision" || e.lane === "sealed")
    .filter((e) => !(e.type === "inbox" && e.summary.startsWith("[L-")))
    .filter((e) => !(e.lane === "sealed" && e.result?.phase !== "attack"))
    .slice(0, 8)
    .map((e) => {
      const who = e.lane === "attacker" ? (e.type === "inbox" ? "A message arrives" : e.type === "tool" ? "A compromised tool" : e.type === "path" ? "A breached path" : "The attacker") : e.lane === "chain" ? "On chain" : e.lane === "human" ? "The owner" : "SeIn";
      const r = e.result;
      const text = e.lane === "sealed" && r ? `${r.verdict}${r.codes.length ? ": " + plain(r.codes) : ""}${r.executed ? ". The money moved" : r.verdict === "BLOCK" ? ". Nothing left the wallet" : r.error ? `. ${r.error}` : ""}.` : e.summary.replace(/(d{6,}) moved/, (_m, n: string) => `${usd(Math.round(Number(n) / 1e4))} moved`);
      return { who, text };
    });
  const list = $("narration");
  list.innerHTML = steps.map((s) => `<li><span class="who">${esc(s.who)}</span>${esc(s.text)}</li>`).join("");
  const items = [...list.querySelectorAll("li")];
  if (instant) items.forEach((li) => li.classList.add("on"));
  else items.forEach((li, i) => setTimeout(() => li.classList.add("on"), 400 + i * 700));
}

const WORDS: Record<string, string> = {
  COUNTERPARTY_BLOCKLISTED: "the receiver is on the blocklist",
  COUNTERPARTY_REPORTED: "another agent reported the receiver",
  PROMPT_INJECTION_SUSPECTED: "the instruction looks like a trick",
  TEE_SIGNAL_BLOCK: "the enclave agrees it is unsafe",
  TEE_SIGNAL_WARN: "the enclave wants a human to look",
  RECIPIENT_NOT_ALLOWLISTED: "the receiver is not a known partner",
  COUNTERPARTY_NEW_ACCOUNT: "the receiver is a brand-new account",
  COUNTERPARTY_FIRST_CONTACT: "never paid before",
  COUNTERPARTY_NOT_FOUND: "the receiver does not exist",
  COUNTERPARTY_CODE_CHANGED: "the contract's code changed",
  RPC_DISAGREEMENT: "data sources disagree",
  LOOKALIKE_ASSET: "a look-alike token",
  EXCESSIVE_VALUE_LOSS: "the route loses too much value",
  LIMIT_EXCEEDED: "a spending limit was reached",
  ABOVE_PER_TX_LIMIT: "over the limit per payment",
  ACTION_CLASS_FORBIDDEN: "this kind of action is never allowed",
  WALLET_FROZEN: "the wallet is frozen",
  METHOD_NOT_ALLOWED: "that contract method is not approved",
  CONTRACT_NOT_ALLOWED: "that contract is not approved",
  DRY_LIVE_DRIFT: "the quote changed before execution",
  TASK_CONTEXT_MISSING: "the instruction was not provided",
};
const plain = (codes: string[]) => [...new Set(codes)].map((c) => WORDS[c] ?? c.toLowerCase().replace(/_/g, " ")).join(", ");

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
  const events = o.events.map((e) => `<li><span class="who">${esc(e.lane)}</span>${esc(e.summary)}</li>`).join("");
  d.innerHTML = `<button class="btn close" id="close">Close</button>
    <h3>${esc(o.scenario.title)}</h3>
    <p>${esc(o.scenario.summary)}</p>
    ${o.scenario.pattern ? `<p class="note">Pattern from <a href="${esc(o.scenario.pattern.source)}">${esc(o.scenario.pattern.incident)}</a>, ${esc(o.scenario.pattern.date)}.</p>` : ""}
    ${o.scenario.cannotReplicate ? `<p class="note">Not replicated: ${esc(o.scenario.cannotReplicate)}</p>` : ""}
    <h3>Evidence: what changed on chain</h3>${changes}
    <h3>What happened</h3><ul class="events">${events}</ul>`;
  d.classList.add("open");
  d.setAttribute("aria-hidden", "false");
  const close = $<HTMLButtonElement>("close");
  close.focus();
  close.addEventListener("click", closeDrawer);
}
function closeDrawer() {
  const d = $("drawer");
  d.classList.remove("open");
  d.setAttribute("aria-hidden", "true");
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

void main();
