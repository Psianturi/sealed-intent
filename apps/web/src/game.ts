// "Be the guard": the visitor makes SeIn's call on ten requests from the official run, then sees the real one.
import { esc } from "./arena-data";
import { reason } from "./copy";
import { pickRounds, score, type Card, type Choice } from "./game-data";
import { GATE_NAMES, sealedGates } from "./storyboard";

const $ = (id: string) => document.getElementById(id)!;
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const SECONDS = 20;
const usd = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const CHOICES: [Choice, string, string][] = [["allow", "Let it through", "1"], ["owner", "Ask the owner", "2"], ["block", "Stop it", "3"]];

let deck: Card[] = [];
let rounds: Card[] = [];
let at = 0;
let total = { points: 0, stolen: 0, blocked: 0, right: 0, keys: 0 };
let timer: number | undefined;
let answered = false;
let onKey: ((e: KeyboardEvent) => void) | undefined;

const best = () => {
  try {
    return Number(localStorage.getItem("sein-guard-best") ?? 0);
  } catch {
    return 0;
  }
};
const saveBest = (n: number) => {
  try {
    if (n > best()) localStorage.setItem("sein-guard-best", String(n));
  } catch {
    /* private mode */
  }
};

function hud() {
  $("gm-round").textContent = `${Math.min(at + 1, rounds.length || 10)}/${rounds.length || 10}`;
  $("gm-score").textContent = String(total.points);
  $("gm-stolen").textContent = usd(total.stolen);
  $("gm-blocked").textContent = String(total.blocked);
}

function keys(handler: (k: string) => void) {
  if (onKey) document.removeEventListener("keydown", onKey);
  onKey = (e: KeyboardEvent) => {
    if ((e.target as Element | null)?.closest?.("input, textarea, select") || document.getElementById("game")!.hidden) return;
    handler(e.key);
  };
  document.addEventListener("keydown", onKey);
}

function intro() {
  at = 0;
  total = { points: 0, stolen: 0, blocked: 0, right: 0, keys: 0 };
  hud();
  $("gm-screen").innerHTML = `
    <div class="gm-intro">
      <p class="cp-eyebrow"><span class="cp-live" aria-hidden="true"></span>Play</p>
      <h2>Be the guard</h2>
      <p>Ten requests reach an AI agent. Each one wants to move money. You make SeIn's call: <b>let it through</b>, <b>ask the owner</b>, or <b>stop it</b>. You have ${SECONDS} seconds; hesitate and the agent goes ahead.</p>
      <p class="gm-small">Every request is real: it comes from the official Arena run. After each call you see what SeIn actually decided, and what the wallets without a guard lost.${best() ? ` Your best: ${best()} points.` : ""}</p>
      <button type="button" class="cp-go gm-start" id="gm-start">Start <kbd>Enter</kbd></button>
    </div>`;
  $("gm-start").onclick = start;
  keys((k) => k === "Enter" && start());
}

function start() {
  rounds = pickRounds(deck);
  at = 0;
  total = { points: 0, stolen: 0, blocked: 0, right: 0, keys: 0 };
  round();
}

function round() {
  const c = rounds[at]!;
  answered = false;
  hud();
  $("gm-screen").innerHTML = `
    <div class="gm-round">
      <div class="gm-inbox">
        <p class="gm-label">The agent's inbox</p>
        <div class="gm-msg"><span class="gm-from">from ${esc(c.from)}</span><p>${esc(c.message)}</p></div>
        ${c.ask ? `<p class="gm-label">So the agent wants to</p><p class="gm-ask">${esc(c.ask)}</p>` : `<p class="gm-label">The agent is never asked</p><p class="gm-ask">The money moves without a request. What would you do?</p>`}
      </div>
      <div class="gm-side">
        <div class="gm-timer" id="gm-timer" style="--p:1"><span id="gm-left">${SECONDS}</span></div>
        <div class="gm-pads">${CHOICES.map(([id, label, key]) => `<button type="button" class="gm-pad ${id}" data-choice="${id}"><kbd>${key}</kbd>${label}</button>`).join("")}</div>
      </div>
    </div>`;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-choice]")) b.onclick = () => decide(b.dataset.choice as Choice, false);
  keys((k) => {
    const pick = CHOICES.find(([, , key]) => key === k);
    if (pick) decide(pick[0], false);
  });
  const ends = performance.now() + SECONDS * 1000;
  const tick = () => {
    if (answered) return;
    const left = Math.max(0, ends - performance.now());
    const el = document.getElementById("gm-timer");
    if (!el) return;
    el.style.setProperty("--p", String(left / (SECONDS * 1000)));
    $("gm-left").textContent = String(Math.ceil(left / 1000));
    el.classList.toggle("late", left < 5000);
    if (left <= 0) return decide("allow", true);
    timer = requestAnimationFrame(tick);
  };
  timer = requestAnimationFrame(tick);
}

const VERDICT: Record<string, [string, string]> = {
  right: ["Right call", "ok"],
  careful: ["Careful call", "careful"],
  wrong: ["", "bad"],
  beyond: ["Beyond any guard", "beyond"],
};

function decide(choice: Choice, late: boolean) {
  if (answered) return;
  answered = true;
  if (timer) cancelAnimationFrame(timer);
  const c = rounds[at]!;
  const s = score(c, choice);
  total.points += s.points;
  total.stolen += s.stolenCents;
  total.blocked += s.honestBlocked ? 1 : 0;
  total.right += s.verdict === "right" ? 1 : 0;
  // letting an attack through hands over whatever it took from the unguarded wallet, keys included
  if (c.kind === "attack" && !c.outOfScope && choice === "allow") total.keys += c.keys["no-guard"];
  hud();
  const said = CHOICES.find(([id]) => id === choice)![1].toLowerCase();
  const head = s.verdict === "wrong" ? (c.kind === "attack" ? `${usd(s.stolenCents)} stolen` : "An honest payment blocked") : VERDICT[s.verdict]![0];
  const note =
    s.verdict === "beyond" ? "No checker in front of a wallet stops this one. It is in the Arena on purpose, to show where any guard ends."
    : c.kind === "attack" ? (choice === "allow" ? "It was an attack, and it got through." : choice === "owner" ? "It was an attack. A careful owner would catch it; a busy one might not." : "It was an attack, and you stopped it.")
    : choice === "block" ? "It was a normal payment. Blocking it means the job does not get done." : c.sein.verdict === "WARN" && choice === "owner" ? "A new receiver: asking the owner is exactly right." : choice === "owner" ? "It was routine. Asking is safe, but the owner gets bothered for nothing." : "It was routine, and it went through.";
  const { gates } = sealedGates({ verdict: c.sein.verdict === "NONE" ? "ALLOW" : c.sein.verdict, codes: [...c.sein.codes, ...c.sein.warnCodes], warnCodes: c.sein.warnCodes, executed: c.sein.outcome === "paid" || c.sein.outcome === "owner-approved" } as never);
  const seinSaid = c.sein.verdict === "NONE" ? "never saw it: the money went around every check" : c.sein.verdict === "WARN" ? `asked the owner, who ${c.sein.outcome === "owner-rejected" ? "rejected it" : "approved it"}` : c.sein.verdict === "BLOCK" ? "stopped it" : "let it through";
  const why = [...new Set([...c.sein.codes, ...c.sein.warnCodes])].slice(0, 3).map(reason);
  const lane = (name: string, lost: number, keys: number, cls: string) => `<div class="gm-lane ${lost || keys ? "lost" : "safe"} ${cls}"><span>${name}</span><b>${[lost ? `−${usd(lost)}` : "", keys ? "key added" : ""].filter(Boolean).join(", ") || (c.kind === "task" ? "paid" : "safe")}</b></div>`;
  $("gm-screen").innerHTML = `
    <div class="gm-reveal">
      <div class="gm-result ${VERDICT[s.verdict]![1]}">
        <p class="gm-you">You said: ${said}${late ? " (time ran out)" : ""}</p>
        <h2>${head}</h2>
        <p>${note}</p>
        ${c.pattern ? `<p class="gm-small">Pattern from ${esc(c.pattern.incident)}, ${esc(c.pattern.date)}.${c.why ? ` ${esc(c.why)}` : ""}</p>` : ""}
      </div>
      <div class="gm-truth">
        <p class="gm-label">What SeIn really did: ${esc(seinSaid)}</p>
        <ol class="t-gates gm-gates">${gates.map((g, i) => `<li class="tg ${c.sein.verdict === "NONE" ? "not_run" : g.status}" style="--i:${i}"><span class="tg-dot"></span><span>${GATE_NAMES[i]}</span>${g.codes.length ? `<small>${esc(reason(g.codes[0]!))}</small>` : ""}</li>`).join("")}</ol>
        ${why.length ? `<p class="gm-small">${why.map(esc).join(" · ")}</p>` : ""}
        <div class="gm-lanes">${lane("No guard", c.lost["no-guard"], c.keys["no-guard"], "")}${lane("Limits only", c.lost["caps-only"], c.keys["caps-only"], "")}${lane("SeIn", c.sein.lostCents, c.keys.sealed, "sein")}</div>
      </div>
      <button type="button" class="cp-go gm-next" id="gm-next">${at + 1 < rounds.length ? "Next request" : "See your score"} <kbd>Enter</kbd></button>
    </div>`;
  const next = () => (at + 1 < rounds.length ? (at++, round()) : end());
  $("gm-next").onclick = next;
  keys((k) => (k === "Enter" || k === "ArrowRight") && next());
  if (!calm) document.getElementById("gm-screen")!.animate([{ opacity: 0.4, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: "ease-out" });
}

function end() {
  const seinStolen = rounds.filter((c) => c.kind === "attack" && !c.outOfScope).reduce((n, c) => n + c.sein.lostCents, 0);
  const oos = rounds.find((c) => c.outOfScope);
  const inScope = rounds.filter((c) => c.kind === "attack" && !c.outOfScope);
  // SeIn's own calls on the same cards, from the recording: an attack is right when nothing left, a task when it was paid
  const seinRight = rounds.filter((c) => !c.outOfScope && (c.kind === "attack" ? c.sein.lostCents === 0 && c.keys.sealed === 0 : c.sein.outcome !== "stopped")).length;
  const noGuardRight = rounds.filter((c) => c.kind === "task").length;
  const beyondLine = oos ? ` "${oos.title}" is beyond any guard: it cost the SeIn wallet ${usd(oos.sein.lostCents)} and the unguarded one ${usd(oos.lost["no-guard"])}.` : "";
  const noGuard = rounds.filter((c) => c.kind === "attack" && !c.outOfScope).reduce((n, c) => n + c.lost["no-guard"], 0);
  const rank = total.stolen === 0 && total.blocked === 0 ? "A guard worth hiring" : total.stolen === 0 ? "Safe, but you blocked honest work" : total.stolen < 5000 ? "Some money walked out" : "The attackers had a good day";
  saveBest(total.points);
  at = rounds.length - 1;
  hud();
  $("gm-screen").innerHTML = `
    <div class="gm-end">
      <p class="cp-eyebrow">Your shift is over</p>
      <h2>${rank}</h2>
      <table class="gm-table">
        <thead><tr><th></th><th>You</th><th>SeIn, same requests</th><th>No guard</th></tr></thead>
        <tbody>
          <tr><th>Stolen by stoppable attacks</th><td>${usd(total.stolen)}</td><td>${usd(seinStolen)}</td><td>${usd(noGuard)}</td></tr>
          <tr><th>Attacker keys handed over</th><td>${total.keys}</td><td>${inScope.reduce((n, c) => n + c.keys.sealed, 0)}</td><td>${inScope.reduce((n, c) => n + c.keys["no-guard"], 0)}</td></tr>
          <tr><th>Honest payments blocked</th><td>${total.blocked}</td><td>0</td><td>0</td></tr>
          <tr><th>Right calls</th><td>${total.right} of ${rounds.filter((c) => !c.outOfScope).length}</td><td>${seinRight} of ${rounds.filter((c) => !c.outOfScope).length}</td><td>${noGuardRight} of ${rounds.filter((c) => !c.outOfScope).length}</td></tr>
        </tbody>
      </table>
      <p class="gm-small">Score ${total.points}. Best ${Math.max(best(), total.points)}.${esc(beyondLine)}</p>
      <div class="cp-actions"><button type="button" class="cp-go" id="gm-again">Play again</button><button type="button" class="cp-ghost" id="gm-watch">Watch the recorded run</button><button type="button" class="cp-ghost" id="gm-cases">Browse every case</button><a class="cp-ghost" href="/try">Try the live firewall</a></div>
    </div>`;
  $("gm-again").onclick = start;
  $("gm-watch").onclick = () => show("watch");
  $("gm-cases").onclick = () => show("cases");
  keys((k) => k === "Enter" && start());
}

type Tab = "play" | "watch" | "cases" | "results";
const PANELS: Record<Tab, string> = { play: "game", watch: "stage", cases: "panel-cases", results: "panel-results" };

function show(tab: Tab) {
  for (const [t, id] of Object.entries(PANELS)) $(id).hidden = t !== tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".ar-tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  // the stage sizes itself from the window; tell it once it is visible again
  if (tab === "watch") window.dispatchEvent(new Event("resize"));
  history.replaceState(null, "", tab === "play" ? location.pathname + location.search : `#${tab}`);
  const bar = document.querySelector(".ar-tabs")!;
  if (bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: "start" });
}

function filters() {
  const bar = document.querySelector<HTMLElement>(".case-filters");
  bar?.addEventListener("click", (e) => {
    const pick = (e.target as Element | null)?.closest?.<HTMLButtonElement>("[data-filter]");
    if (!pick) return;
    for (const b of bar.querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(b === pick));
    for (const c of document.querySelectorAll<HTMLElement>(".case-card")) c.hidden = pick.dataset.filter !== "all" && c.dataset.group !== pick.dataset.filter;
  });
}

async function main() {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".ar-tabs [data-tab]")) b.onclick = () => show(b.dataset.tab as Tab);
  // a picked case plays on the stage; capture runs first, so the stage is visible when it mounts
  document.addEventListener("click", (e) => {
    if ((e.target as Element | null)?.closest?.("[data-case]")) show("watch");
  }, true);
  filters();
  const present = new URLSearchParams(location.search).has("present");
  const hash = location.hash.slice(1) as Tab;
  show(present ? "watch" : Object.hasOwn(PANELS, hash) ? hash : "play");
  deck = await fetch("/storyboard/game.json").then((r) => r.json() as Promise<Card[]>).catch(() => []);
  if (!deck.length) {
    $("gm-screen").innerHTML = `<p class="gm-small">The game could not load. <button type="button" class="cp-ghost" id="gm-watch">Watch the recorded run</button></p>`;
    $("gm-watch").onclick = () => show("watch");
    return;
  }
  intro();
}
void main();
