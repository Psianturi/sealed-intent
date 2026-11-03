// The Vault Run: one case on the stage, built from the storyboard and played on a seekable timeline.
import { LANE_NAMES, usd, type LaneId } from "../arena-data";
import { reason } from "../copy";
import { GATE_NAMES, gateLook, type Gate, type LaneStory, type StoryCase, type Storyboard } from "../storyboard";
import { span, Timeline } from "./timeline";

const NS = "http://www.w3.org/2000/svg";
const LANE_ORDER: LaneId[] = ["no-guard", "caps-only", "sealed"];
const START_CENTS = 50000;

type El = SVGElement;
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}
function h(tag: string, cls: string, parent?: Element, html?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  parent?.appendChild(e);
  return e;
}
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const short = (name: string, n: number) => (name.length > n ? `${name.slice(0, n - 1)}…` : name);

interface LaneGeo { y: number; k: number; ghost: boolean }
interface Geo { w: number; h: number; mobile: boolean; lanes: Record<LaneId, LaneGeo>; vaultX: number; rail0: number; rail1: number; destX: number; labelX: number; gateAt: number[]; capsAt: number }

function geometry(mobile: boolean): Geo {
  return mobile
    ? { w: 390, h: 470, mobile, lanes: { "no-guard": { y: 54, k: 0.42, ghost: true }, "caps-only": { y: 104, k: 0.42, ghost: true }, sealed: { y: 320, k: 0.82, ghost: false } }, vaultX: 40, rail0: 78, rail1: 312, destX: 350, labelX: 0, gateAt: [0.13, 0.31, 0.5, 0.69, 0.87], capsAt: 0.5 }
    : { w: 1440, h: 640, mobile, lanes: { "no-guard": { y: 232, k: 0.84, ghost: false }, "caps-only": { y: 372, k: 0.92, ghost: false }, sealed: { y: 522, k: 1, ghost: false } }, vaultX: 238, rail0: 300, rail1: 1104, destX: 1166, labelX: 1220, gateAt: [0.16, 0.32, 0.48, 0.64, 0.8], capsAt: 0.5 };
}

const railX = (g: Geo, f: number) => g.rail0 + (g.rail1 - g.rail0) * f;

// icon paths in a 24 box, line style
const ICONS = [
  "M12 3v18M5 7h14M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0zM8 21h8",
  "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 10-4.5M16 17l2 2 4-4",
  "M7 14a5 5 0 1 1 3.5-8.5L21 16v3h-3v-2h-2v-2h-2l-1.5-1.5A5 5 0 0 1 7 14zM3 3l18 18",
  "M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM5 12s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z",
  "M12 14l4-4M3.3 19a10 10 0 1 1 17.4 0",
];
const KEY = "M7 14a5 5 0 1 1 3.5-8.5L21 16v3h-3v-2h-2v-2h-2l-1.5-1.5A5 5 0 0 1 7 14z";
const PEN = "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z";

interface GateEls { g: SVGGElement; inner: SVGGElement; pass: El; fail: El; warn: El; doors: El[]; check: El; scan: El; x: number }
interface LaneEls { doneAt?: number; g: SVGGElement; capsule: SVGGElement; trail: El; trailBad: El; gates: GateEls[]; vaultDoor: El; balance: SVGTextElement; destCount: SVGTextElement; destPulse: El; result: SVGGElement; resultMain: SVGTextElement; resultSub: SVGTextElement; bubble: SVGGElement; bubbleText: SVGTextElement; key?: El }

export interface Mounted {
  timeline: Timeline;
  acts: [string, number][];
  destroy(): void;
}

export interface StageHost {
  screen: HTMLElement;
  caption: HTMLElement;
  chapters: HTMLElement;
  title: HTMLElement;
}

export function mountCase(host: StageHost, board: Storyboard, c: StoryCase, opts: { mobile: boolean; reduced: boolean; index: number; total: number; verifyHref?: string; next?: StoryCase }): Mounted {
  const g = geometry(opts.mobile);
  host.screen.innerHTML = "";
  host.screen.classList.toggle("oos", c.outOfScope);
  host.screen.classList.toggle("mobile", opts.mobile);
  const svg = s("svg", { viewBox: `0 0 ${g.w} ${g.h}`, class: "vr-svg", role: "img", "aria-label": `${c.title}: three lanes, the same request` }, host.screen);
  const defs = s("defs", {}, svg);
  defs.innerHTML = `
    <radialGradient id="vr-glow"><stop offset="0" stop-color="#6E8BFF" stop-opacity=".55"/><stop offset="1" stop-color="#6E8BFF" stop-opacity="0"/></radialGradient>
    <radialGradient id="vr-glow-mint"><stop offset="0" stop-color="#3EE6A8" stop-opacity=".5"/><stop offset="1" stop-color="#3EE6A8" stop-opacity="0"/></radialGradient>
    <radialGradient id="vr-glow-ember"><stop offset="0" stop-color="#FF5A4E" stop-opacity=".5"/><stop offset="1" stop-color="#FF5A4E" stop-opacity="0"/></radialGradient>
    <radialGradient id="vr-vignette" cx=".5" cy=".55" r=".75"><stop offset=".55" stop-color="#05070C" stop-opacity="0"/><stop offset="1" stop-color="#05070C" stop-opacity=".9"/></radialGradient>
    <pattern id="vr-hazard" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="10" height="10" fill="#FF5A4E"/><rect width="5" height="10" fill="#1a0b0a"/></pattern>
    <linearGradient id="vr-beam" x1="0" x2="1"><stop offset="0" stop-color="#6E8BFF" stop-opacity="0"/><stop offset=".5" stop-color="#6E8BFF" stop-opacity=".85"/><stop offset="1" stop-color="#6E8BFF" stop-opacity="0"/></linearGradient>`;

  // floor with a perspective grid
  s("rect", { width: g.w, height: g.h, class: "vr-floor" }, svg);
  const grid = s("g", { class: "vr-grid" }, svg);
  const vx = g.w / 2;
  const vy = -g.h * 0.9;
  for (let i = -12; i <= 12; i++) {
    const x = vx + i * (g.w / 12);
    s("line", { x1: x, y1: g.h, x2: vx + (x - vx) * 0.35, y2: g.h * 0.12, class: "vr-gridline" }, grid);
  }
  for (const f of [0.18, 0.3, 0.46, 0.66, 0.9]) s("line", { x1: 0, y1: g.h * f, x2: g.w, y2: g.h * f, class: "vr-gridline" }, grid);
  void vy;

  const world = s("g", { class: "vr-world" }, svg);
  s("rect", { width: g.w, height: g.h, fill: "url(#vr-vignette)", "pointer-events": "none" }, svg);

  const tl = new Timeline();
  const lanes = {} as Record<LaneId, LaneEls>;
  const sealedMain = c.lanes.sealed;
  const destCls = c.destination.attacker ? "attacker" : "legit";

  for (const id of LANE_ORDER) {
    const L = g.lanes[id];
    const k = L.k;
    const lg = s("g", { class: `vr-lane ${id}${L.ghost ? " ghost" : ""}` }, world);
    const y = L.y;
    if (id === "sealed" && !g.mobile) s("rect", { x: 20, y: y - 92, width: g.w - 40, height: 150, rx: 18, class: "vr-lane-bed" }, lg);
    // label, upright
    if (g.mobile) s("text", { x: L.ghost ? 8 : 16, y: L.ghost ? y - 14 : y - 92, class: `vr-lane-label${L.ghost ? " small" : ""}` }, lg, LANE_NAMES[id].toUpperCase());
    else {
      s("text", { x: 36, y: y - 6, class: "vr-lane-label" }, lg, (id === "sealed" ? "SEALED INTENT" : LANE_NAMES[id]).toUpperCase());
      s("text", { x: 36, y: y + 16, class: "vr-lane-sub" }, lg, id === "no-guard" ? "signs whatever it decides" : id === "caps-only" ? "one $50 limit" : "five checks");
    }
    const vX = L.ghost ? 30 : g.vaultX;
    const rail0 = L.ghost ? 46 : g.rail0;
    const rail1 = L.ghost ? 330 : g.rail1;
    const dX = L.ghost ? 352 : g.destX;
    s("line", { x1: rail0, y1: y, x2: rail1, y2: y, class: "vr-rail" }, lg);
    const trail = s("rect", { x: vX, y: y - 2 * k, width: dX - vX, height: 4 * k, class: "vr-trail" }, lg);
    const trailBad = s("rect", { x: vX, y: y - 2 * k, width: dX - vX, height: 4 * k, class: "vr-trail bad" }, lg);
    // vault
    const vault = s("g", { class: "vr-vault", transform: `translate(${vX} ${y})` }, lg);
    s("circle", { r: 40 * k, class: "vr-vault-ring" }, vault);
    const door = s("g", { class: "vr-vault-door" }, vault);
    s("circle", { r: 30 * k, class: "vr-vault-face" }, door);
    for (let a = 0; a < 6; a++) s("line", { x1: 0, y1: 0, x2: Math.cos((a * Math.PI) / 3) * 22 * k, y2: Math.sin((a * Math.PI) / 3) * 22 * k, class: "vr-vault-spoke" }, door);
    s("circle", { r: 7 * k, class: "vr-vault-hub" }, door);
    const balance = s("text", { x: 0, y: (L.ghost ? 0 : 62) * k + (L.ghost ? 4 : 0), class: `vr-count${L.ghost ? " hidden" : ""}` }, vault, usd(START_CENTS));
    // destination
    const dest = s("g", { class: `vr-dest ${destCls}`, transform: `translate(${dX} ${y})` }, lg);
    const destPulse = s("circle", { r: 36 * k, class: "vr-dest-pulse" }, dest);
    s("circle", { r: 34 * k, class: "vr-dest-ring" }, dest);
    s("circle", { r: 22 * k, class: "vr-dest-face" }, dest);
    if (!L.ghost) s("text", { x: g.mobile ? -10 : 0, y: 56 * k, class: "vr-dest-name" }, dest, g.mobile ? (c.destination.attacker ? "Unknown" : short(c.destination.name, 10)) : short(c.destination.attacker ? "Unknown wallet" : c.destination.name, 18));
    const destCount = s("text", { x: 0, y: -48 * k, class: `vr-count small${L.ghost ? " hidden" : ""}` }, dest, "");
    // agent chip and bubble
    const bubble = s("g", { class: "vr-bubble", transform: `translate(${vX - 18} ${y - (L.ghost ? 18 : 74 * k)})` }, lg);
    if (!L.ghost) {
      s("rect", { x: -8, y: -16, width: 62, height: 26, rx: 13, class: "vr-agent" }, bubble);
      s("text", { x: 23, y: 2, class: "vr-agent-text" }, bubble, "agent");
    }
    const bubbleText = s("text", { x: L.ghost ? 0 : 66, y: 2, class: `vr-bubble-text${L.ghost ? " hidden" : ""}` }, bubble, "");
    // gates
    const gates: GateEls[] = [];
    const lanesGates = c.lanes[id].gates;
    lanesGates.forEach((gate, i) => {
      const x = id === "sealed" ? (L.ghost ? 0 : railX(g, g.gateAt[i]!)) : L.ghost ? 188 : railX(g, g.capsAt);
      const outer = s("g", { class: `vr-gate look-${gateLook(gate)}`, transform: `translate(${x} ${y})` }, lg);
      const gg = s("g", { class: "vr-gate-inner" }, outer);
      const H = (L.ghost ? 18 : 62) * k;
      const W = (L.ghost ? 10 : 34) * k;
      const posts = (cls: string) => {
        const p = s("g", { class: cls }, gg);
        s("rect", { x: -W / 2 - 3, y: -H, width: 5, height: H + 8 * k, rx: 2 }, p);
        s("rect", { x: W / 2 - 2, y: -H, width: 5, height: H + 8 * k, rx: 2 }, p);
        s("rect", { x: -W / 2 - 6, y: -H - 6, width: W + 12, height: 7, rx: 3 }, p);
        return p;
      };
      posts("vr-gate-base");
      const pass = posts("vr-gate-pass");
      const fail = posts("vr-gate-fail");
      const warn = posts("vr-gate-warn");
      const scan = s("rect", { x: -W / 2, y: -H, width: W, height: H + 6, fill: "url(#vr-beam)", class: "vr-scan" }, gg);
      const doors = [s("rect", { x: -W / 2 + 2, y: -H + 2, width: W / 2 - 2, height: H + 4 * k, fill: "url(#vr-hazard)", class: "vr-door left" }, gg), s("rect", { x: 0, y: -H + 2, width: W / 2 - 2, height: H + 4 * k, fill: "url(#vr-hazard)", class: "vr-door right" }, gg)];
      if (!L.ghost) {
        const icon = s("g", { class: "vr-gate-icon", transform: `translate(-12 ${-H - 40 * k}) scale(${k})` }, gg);
        s("path", { d: id === "sealed" ? ICONS[i]! : ICONS[4]! }, icon);
        if (!g.mobile) s("text", { x: 0, y: 30 * k, class: "vr-gate-label" }, gg, id === "sealed" ? GATE_NAMES[i]!.toUpperCase() : "LIMIT $50");
        else s("text", { x: 0, y: 24 * k, class: "vr-gate-label" }, gg, id === "sealed" ? String(i + 1) : "$50");
      }
      const checkAt = s("g", { transform: `translate(0 ${-H / 2 + 2})` }, gg);
      const check = s("path", { d: L.ghost ? "M-3 0l2 2 4-5" : "M-8 0l5 5 10-11", class: "vr-check" }, checkAt);
      gates.push({ g: outer, inner: gg, pass, fail, warn, doors, check, scan, x });
    });
    // capsule
    const capsule = s("g", { class: "vr-capsule" }, lg);
    s("circle", { r: (L.ghost ? 14 : 34) * k, fill: "url(#vr-glow)", class: "vr-cap-glow" }, capsule);
    const pillW = (L.ghost ? 30 : c.ask.form === "money" ? 70 : 54) * k;
    const pillH = (L.ghost ? 14 : 30) * k;
    s("rect", { x: -pillW / 2, y: -pillH / 2, width: pillW, height: pillH, rx: pillH / 2, class: "vr-pill" }, capsule);
    if (c.ask.form === "money" || L.ghost) s("text", { x: 0, y: (L.ghost ? 3.5 : 5) * k + (L.ghost ? 0 : 0), class: `vr-pill-text${L.ghost ? " small" : ""}` }, capsule, L.ghost ? c.ask.label.replace(/^\$/, "$") : c.ask.label);
    else {
      const icon = s("g", { transform: `translate(${-12 * k} ${-12 * k}) scale(${k})`, class: "vr-pill-icon" }, capsule);
      s("path", { d: c.ask.form === "key" ? KEY : PEN }, icon);
    }
    let key: El | undefined;
    if (c.moment.kind === "key-xray" && !L.ghost) {
      key = s("g", { class: "vr-hidden-key", transform: `translate(${18 * k} ${-26 * k}) scale(${0.7 * k})` }, capsule);
      s("path", { d: KEY }, key);
    }
    // result
    const result = s("g", { class: "vr-result", transform: g.mobile ? `translate(${L.ghost ? 330 : 195} ${L.ghost ? y - 10 : y + 92})` : `translate(${g.labelX} ${y})` }, lg);
    const resultMain = s("text", { x: 0, y: g.mobile && !L.ghost ? 0 : -2, class: `vr-result-main${L.ghost ? " small" : ""}` }, result, "");
    const resultSub = s("text", { x: 0, y: g.mobile && !L.ghost ? 20 : 18, class: `vr-result-sub${L.ghost ? " hidden" : ""}` }, result, "");
    lanes[id] = { g: lg, capsule, trail, trailBad, gates, vaultDoor: door, balance, destCount, destPulse, result, resultMain, resultSub, bubble, bubbleText, key };
  }

  // HTML overlays
  const message = h("div", "vr-message", host.screen);
  if (c.message) message.innerHTML = `<p class="vr-from">${esc(c.message.from)}</p><p class="vr-msg-text">${highlighted(c.message.text, c.message.highlights)}</p>`;
  const owner = h("div", "vr-owner", host.screen, `<p class="vr-owner-title">Your agent is asking</p><p class="vr-owner-what">${esc(c.ask.what)}</p><p class="vr-owner-why">${esc(sealedMain.codes.filter((x) => !/LIMIT|TEE_SIGNAL_BLOCK/.test(x)).slice(0, 2).map(reason).join(". "))}</p><div class="vr-owner-buttons"><span class="vr-btn approve">Approve</span><span class="vr-btn reject">Reject</span></div>`);
  const ledger = h("div", "vr-ledger", host.screen, `<p class="vr-ledger-head">Referee · reads only on-chain balances, keys and code</p><div class="vr-ledger-cols">${LANE_ORDER.map((l) => `<div><span>${LANE_NAMES[l]}</span><b data-lane="${l}">$0.00</b></div>`).join("")}</div><p class="vr-ledger-note">The referee never reads our verdicts.</p>`);
  const receipt = c.receipt
    ? h("div", "vr-receipt", host.screen, `<div class="vr-receipt-paper"><p><span>VERDICT</span><b>${esc(c.receipt.verdict)}</b></p><p><span>REASONS</span><em>${esc([...new Set(c.receipt.codes.filter((x) => !c.receipt!.warnCodes.includes(x)).concat(c.receipt.warnCodes))].slice(0, 2).map(reason).join(". "))}.</em></p><p><span>AMOUNT</span><i class="vr-seal"></i></p><p><span>RECEIVER</span><i class="vr-seal"></i></p><p><span>SIGNED</span><em>operator key</em></p><div class="vr-stamp">SEALED</div></div>${opts.verifyHref ? `<a class="vr-verify" href="${opts.verifyHref}">Verify this receipt</a>` : ""}`)
    : undefined;
  const banner = c.outOfScope ? h("div", "vr-banner", host.screen, `<b>Out of scope by design</b><span>${c.moment.kind === "bypass" ? "It went around every check. Only a custody policy or an on-chain guard can hold this." : "The checks ran on false information. Only a custody policy or an on-chain guard can hold this."}</span>`) : undefined;
  const nextCard = opts.next ? h("div", "vr-next", host.screen, `<span>Next case</span><b>${esc(opts.next.title)}</b>`) : undefined;
  const lens = c.moment.kind === "address-diff" ? h("div", "vr-lens", host.screen, `<p>${diffLine(c.moment.real, c.moment.fake, "real")}</p><p>${diffLine(c.moment.fake, c.moment.real, "fake")}</p><span>Same look. A different account.</span>`) : undefined;
  const gauge = c.moment.kind === "budget-gauge" ? h("div", "vr-gauge", host.screen, `<div class="vr-gauge-bar"><i style="width:${Math.min(c.moment.sharePct, 100)}%"></i></div><span>${c.moment.sharePct}% of the balance in one payment</span>`) : undefined;
  const gap = c.moment.kind === "price-gap" ? h("div", "vr-gap", host.screen, `<div><span>Fair price</span><i style="width:100%"></i></div><div><span>This route</span><i class="bad" style="width:${100 - c.moment.lossPct}%"></i></div><b>${c.moment.lossPct}% of the value lost</b>`) : undefined;

  host.title.innerHTML = `<p class="vr-case">${c.kind === "everyday" ? "BASELINE" : `CASE ${String(opts.index).padStart(2, "0")}`}${c.outOfScope ? ' <span class="vr-oos-tag">out of scope</span>' : ""}</p><h3>${esc(c.title)}</h3><p class="vr-pattern">${c.pattern ? `Pattern from ${esc(c.pattern.incident)}, ${esc(c.pattern.date)}` : c.kind === "everyday" ? "No attack: an honest payment" : "A hypothetical attack"}</p>`;

  // ------------------------------------------------------------ the timeline
  const R = opts.reduced;
  const d = (n: number) => (R ? Math.min(n, 0.15) : n);
  const captions: [number, string][] = [];
  const say = (at: number, text: string) => captions.push([at, text]);
  const acts: [string, number][] = [];
  const act = (name: string, at: number) => (acts.push([name, at]), tl.label(name, at));

  // act 0: the stage lights up
  act("Opening", 0);
  tl.to(svg, [{ opacity: 0 }, { opacity: 1 }], 0, d(0.9), "ease-out");
  tl.to(host.title, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], 0.2, d(0.6));

  // act 1: the message, split into three
  act("Message", 1.2);
  if (c.message) {
    tl.to(message, [{ opacity: 0, transform: "translate(-24px,-12px)" }, { opacity: 1, transform: "none" }], 1.2, d(0.6), "cubic-bezier(.2,.8,.2,1)");
    say(1.3, c.kind === "everyday" ? "A normal request reaches three identical agents." : "The same message reaches three identical agents.");
  } else say(1.3, "Something happens that no agent was asked about.");

  // act 2: each agent decides
  act("Decision", 3.4);
  const typeStart = 3.5;
  for (const id of LANE_ORDER) {
    const L = lanes[id];
    tl.to(L.bubble, [{ opacity: 0 }, { opacity: 1 }], 3.4, d(0.3));
    tl.track((t) => {
      const full = g.lanes[id].ghost ? "" : `${c.ask.what}`;
      L.bubbleText.textContent = full.slice(0, Math.round(full.length * span(t, typeStart, R ? 0 : 0.6)));
    });
    tl.to(L.vaultDoor, [{ transform: "rotate(0deg)" }, { transform: "rotate(40deg)" }], 4.1, d(0.5));
    tl.to(L.capsule, [{ opacity: 0, transform: `translate(${vaultOf(g, id)}px, ${g.lanes[id].y}px) scale(.6)` }, { opacity: 1, transform: `translate(${vaultOf(g, id)}px, ${g.lanes[id].y}px) scale(1)` }], 4.4, d(0.4), "cubic-bezier(.3,1.6,.5,1)");
    tl.to(L.bubble, [{ opacity: 1 }, { opacity: 0 }], 5.2, d(0.4));
  }
  if (c.message) tl.to(message, [{ opacity: 1 }, { opacity: g.mobile ? 0 : 0.55 }], 4.6, d(0.4));
  say(3.5, c.ask.what ? `Each agent decides to ${c.ask.what}.` : "No agent asked for anything. The money leaves another way.");

  // act 3: the journeys
  act("Journey", 5);
  const T = 5;
  const lostLanes = LANE_ORDER.filter((l) => c.lanes[l].outcome === "lost" || c.lanes[l].outcome === "key");
  let sealedEnd = T;
  for (const id of LANE_ORDER) {
    const story = c.lanes[id];
    const L = lanes[id];
    const y = g.lanes[id].y;
    const from = vaultOf(g, id);
    const to = destOf(g, id);
    const ghost = g.lanes[id].ghost;
    const at = (x: number) => `translate(${x}px, ${y}px)`;
    const trailTo = (x0: number, x1: number, t0: number, dur: number, bad = false) => tl.to(bad ? L.trailBad : L.trail, [{ transform: `scaleX(${(x0 - from) / (to - from)})` }, { transform: `scaleX(${(x1 - from) / (to - from)})` }], t0, dur, "linear");
    if (c.moment.kind === "bypass") {
      // around the checks: an arc over the gates
      const t0 = T + (id === "sealed" ? 0.8 : 0);
      const pts = arc(from, to, y, ghost ? 26 : 120);
      tl.to(L.capsule, pts.map(([x, yy]) => ({ transform: `translate(${x}px, ${yy}px)` })), t0, d(2.2), "ease-in-out");
      for (const gt of L.gates) tl.to(gt.g, [{ opacity: 1 }, { opacity: 0.55 }], t0, d(0.4));
      arrive(tl, L, t0 + 2.2, story.lostCents, d, true);
      if (id === "sealed") sealedEnd = t0 + 2.6;
      continue;
    }
    if (id === "no-guard") {
      tl.to(L.capsule, [{ transform: at(from) }, { transform: at(to) }], T, d(1.6), "cubic-bezier(.55,0,.3,1)");
      trailTo(from, to, T, d(1.6), lostLanes.includes(id));
      arrive(tl, L, T + 1.6, story.lostCents, d, c.destination.attacker);
      continue;
    }
    if (id === "caps-only") {
      const gx = L.gates[0]?.x ?? (from + to) / 2;
      tl.to(L.capsule, [{ transform: at(from) }, { transform: at(gx - (ghost ? 0 : 30)) }], T, d(1), "cubic-bezier(.4,0,.2,1)");
      trailTo(from, gx, T, d(1));
      const gate = story.gates[0]!;
      gateResult(tl, L.gates[0]!, gate, T + 1, d, ghost);
      if (gate.status === "fail") {
        tl.to(L.capsule, [{ transform: at(gx - 30) }, { transform: at(from) }], T + 1.8, d(0.9), "cubic-bezier(.3,1.4,.4,1)");
        trailTo(gx, from, T + 1.8, d(0.9));
        home(tl, L, T + 2.7, d);
      } else {
        tl.to(L.capsule, [{ transform: at(gx - 30) }, { transform: at(to) }], T + 1.7, d(0.9), "cubic-bezier(.55,0,.3,1)");
        trailTo(gx, to, T + 1.7, d(0.9), lostLanes.includes(id));
        arrive(tl, L, T + 2.6, story.lostCents, d, c.destination.attacker);
      }
      continue;
    }
    // SeIn's lane: gate by gate
    let t = T + 0.8;
    let x = from;
    const step = R ? 0.4 : 1.1;
    const stop = story.stopAt;
    const reachedGates = story.gates.map((gt, i) => ({ gt, i })).filter(({ gt }) => gt.reached);
    for (const { gt, i } of reachedGates) {
      const gx = L.gates[i]!.x;
      tl.to(L.capsule, [{ transform: at(x) }, { transform: at(gx - (ghost ? 0 : 40)) }], t, d(0.45), "cubic-bezier(.4,0,.2,1)");
      trailTo(x, gx, t, d(0.45));
      x = gx - (ghost ? 0 : 40);
      gateResult(tl, L.gates[i]!, gt, t + 0.45, d, ghost, i === stop);
      if (gt.status === "warn" && i !== stop) say(t + 0.5, `Check ${i + 1} · ${GATE_NAMES[i]} ${reasonOf(gt)} Noted, not enough to stop it.`);
      if (i === 3 && c.message && gt.codes.some((x) => /INJECTION|TEE/.test(x))) {
        tl.to(message, [{ opacity: 0.55 }, { opacity: 1 }], t + 0.45, d(0.3));
        if (g.mobile) tl.to(message, [{ opacity: 1 }, { opacity: 0 }], t + 2.4, d(0.3));
      }
      if (i === 3 && c.message) tl.track((tt) => message.classList.toggle("lit", tt >= t + 0.45 && gt.codes.some((x) => /INJECTION|TEE/.test(x))));
      if (i === stop) {
        t += step;
        if (gt.status === "warn" && story.owner) {
          // the owner decides
          tl.to(owner, [{ opacity: 0, transform: "translateY(40px)" }, { opacity: 1, transform: "none" }], t, d(0.5));
          tl.track((tt) => owner.classList.toggle("pressed-reject", story.owner === "rejected" && tt >= t + 1.4));
          tl.track((tt) => owner.classList.toggle("pressed-approve", story.owner === "approved" && tt >= t + 1.4));
          say(t, `Check ${i + 1} · ${GATE_NAMES[i]} ${reasonOf(gt)} The owner decides.`);
          if (lens) tl.to(lens, [{ opacity: 0, transform: "scale(.94)" }, { opacity: 1, transform: "none" }], t - 0.6, d(0.4)), tl.to(lens, [{ opacity: 1 }, { opacity: 0 }], t + 2.4, d(0.3));
          say(t + 1.4, story.owner === "rejected" ? "The owner reads it and rejects it." : "The owner approves without reading.");
          tl.to(owner, [{ opacity: 1 }, { opacity: 0, transform: "translateY(30px)" }], t + 2.4, d(0.4));
          t += 2.6;
          if (story.owner === "approved") {
            gateResult(tl, L.gates[i]!, { ...gt, status: "pass" }, t - 0.2, d, ghost);
            const rest = story.gates.slice(i + 1);
            for (const [j] of rest.entries()) {
              const gx2 = L.gates[i + 1 + j]!.x;
              tl.to(L.capsule, [{ transform: at(x) }, { transform: at(gx2 - 40) }], t, d(0.35), "linear");
              trailTo(x, gx2, t, d(0.35));
              x = gx2 - 40;
              gateResult(tl, L.gates[i + 1 + j]!, { ...rest[j]!, reached: true }, t + 0.35, d, ghost);
              t += R ? 0.3 : 0.7;
            }
            tl.to(L.capsule, [{ transform: at(x) }, { transform: at(to) }], t, d(0.8), "cubic-bezier(.55,0,.3,1)");
            trailTo(x, to, t, d(0.8), story.outcome === "lost");
            arrive(tl, L, t + 0.8, story.lostCents, d, c.destination.attacker);
            sealedEnd = t + 1.2;
            break;
          }
          doorsClose(tl, L.gates[i]!, t - 0.6, d);
        } else {
          say(t - step + 0.5, `Check ${i + 1} · ${GATE_NAMES[i]} ${reasonOf(gt)} Stopped.`);
          if (gauge && i === 4) tl.to(gauge, [{ opacity: 0 }, { opacity: 1 }], t - step, d(0.4)), tl.to(gauge, [{ opacity: 1 }, { opacity: 0 }], t + 2, d(0.3));
          if (gap && i === 0) tl.to(gap, [{ opacity: 0 }, { opacity: 1 }], t - step, d(0.4)), tl.to(gap, [{ opacity: 1 }, { opacity: 0 }], t + 2, d(0.3));
          if (L.key && i === 2) tl.to(L.key, [{ opacity: 0, transform: "scale(.5)" }, { opacity: 1, transform: "scale(1.3)" }], t - step + 0.3, d(0.4));
        }
        // back home
        tl.to(L.capsule, [{ transform: at(x) }, { transform: at(from) }], t + 0.2, d(0.9), "cubic-bezier(.3,1.4,.4,1)");
        trailTo(x, from, t + 0.2, d(0.9));
        home(tl, L, t + 1.1, d);
        sealedEnd = t + 1.6;
        break;
      }
      t += step;
      if (i === reachedGates[reachedGates.length - 1]!.i && stop === null) {
        tl.to(L.capsule, [{ transform: at(x) }, { transform: at(to) }], t, d(0.8), "cubic-bezier(.55,0,.3,1)");
        trailTo(x, to, t, d(0.8), story.outcome === "lost");
        arrive(tl, L, t + 0.8, story.lostCents, d, c.destination.attacker);
        sealedEnd = t + 1.2;
      }
    }
    if (reachedGates.length === 0) sealedEnd = t;
  }
  // the camera follows SeIn's lane while it travels
  if (!g.mobile && !R) {
    tl.to(world, [{ transform: "scale(1) translate(0,0)" }, { transform: "scale(1.1) translate(-26px,-52px)" }], T + 0.6, 0.8, "cubic-bezier(.45,0,.2,1)");
    tl.to(lanes["no-guard"].g, [{ opacity: 1 }, { opacity: 0.45 }], T + 2.6, 0.5);
    tl.to(lanes["caps-only"].g, [{ opacity: 1 }, { opacity: 0.45 }], T + 3, 0.5);
    tl.to(world, [{ transform: "scale(1.1) translate(-26px,-52px)" }, { transform: "scale(1) translate(0,0)" }], sealedEnd + 0.4, 0.7, "cubic-bezier(.45,0,.2,1)");
    tl.to(lanes["no-guard"].g, [{ opacity: 0.45 }, { opacity: 1 }], sealedEnd + 0.4, 0.5);
    tl.to(lanes["caps-only"].g, [{ opacity: 0.45 }, { opacity: 1 }], sealedEnd + 0.4, 0.5);
  }
  if (banner) tl.to(banner, [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], T + 0.6, d(0.5));

  // act 4: the verdict
  const V = Math.max(sealedEnd + 0.3, T + 4);
  act("Verdict", V);
  for (const id of LANE_ORDER) settle(tl, lanes[id], c.lanes[id], id, Math.min(lanes[id].doneAt ?? V, V));
  say(V, verdictLine(c));

  // act 5: the referee
  const F = V + 2.4;
  act("Referee", F);
  tl.to(ledger, [{ opacity: 0, transform: "translateY(60px)" }, { opacity: 1, transform: "none" }], F, d(0.6));
  ledger.querySelectorAll<HTMLElement>("b[data-lane]").forEach((b, i) => {
    const l = b.dataset.lane as LaneId;
    const st = c.lanes[l];
    b.classList.toggle("bad", st.lostCents > 0 || st.keysAdded > 0);
    tl.track((t) => {
      const p = span(t, F + 0.5 + i * 0.12, R ? 0 : 0.7);
      b.textContent = st.keysAdded && !st.lostCents ? (p >= 1 ? `+${st.keysAdded} attacker key` : "…") : `${st.lostCents ? "−" : ""}${usd(Math.round(st.lostCents * p))}`;
    });
  });
  say(F + 0.2, "The referee counts only what actually moved on chain.");

  // act 6: the receipt
  const P = F + 3;
  act("Receipt", P);
  tl.to(ledger, [{ opacity: 1 }, { opacity: 0 }], P, d(0.4));
  if (receipt) {
    tl.to(receipt, [{ opacity: 0, clipPath: "inset(0 0 100% 0)" }, { opacity: 1, clipPath: "inset(0 0 0 0)" }], P + 0.2, d(0.7), "ease-out");
    tl.to(receipt.querySelector(".vr-stamp"), [{ opacity: 0, transform: "rotate(-6deg) scale(1.4)" }, { opacity: 1, transform: "rotate(-6deg) scale(1)" }], P + 1.1, d(0.35), "cubic-bezier(.3,1.6,.5,1)");
    say(P + 0.3, "Proof that SeIn decided, without revealing the amount or the receiver.");
  } else say(P + 0.3, c.kind === "everyday" ? "Every lane paid. SeIn blocked nothing honest." : "SeIn never saw this request, so there is no receipt for it.");
  const END = P + 2.6;
  if (nextCard) tl.to(nextCard, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], END - 0.6, d(0.4));
  tl.track(() => undefined, END);

  // captions and chapter rail follow the clock
  captions.sort((a, b) => a[0] - b[0]);
  host.chapters.innerHTML = acts.map(([name]) => `<li><button type="button">${name}</button></li>`).join("");
  const chapterButtons = [...host.chapters.querySelectorAll("li")];
  let lastCaption = "";
  tl.track((t) => {
    const cap = [...captions].reverse().find(([at]) => at <= t)?.[1] ?? "";
    if (cap !== lastCaption) {
      host.caption.textContent = cap;
      lastCaption = cap;
    }
    const current = acts.reduce((n, [, at], i) => (t >= at ? i : n), 0);
    chapterButtons.forEach((li, i) => li.classList.toggle("on", i <= current));
  });
  chapterButtons.forEach((li, i) => li.querySelector("button")!.addEventListener("click", () => tl.seek(acts[i]![1])));
  tl.seek(0);
  return { timeline: tl, acts, destroy: () => tl.destroy() };
}

function vaultOf(g: Geo, id: LaneId) {
  return g.lanes[id].ghost ? 30 : g.vaultX;
}
function destOf(g: Geo, id: LaneId) {
  return g.lanes[id].ghost ? 352 : g.destX;
}

function arc(x0: number, x1: number, y: number, lift: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 12; i++) {
    const f = i / 12;
    pts.push([x0 + (x1 - x0) * f, y - Math.sin(Math.PI * f) * lift]);
  }
  return pts;
}

function gateResult(tl: Timeline, el: GateEls, gate: Gate, at: number, d: (n: number) => number, ghost: boolean, stopping = false) {
  if (!ghost) tl.to(el.scan, [{ opacity: 0, transform: "translateX(-30px)" }, { opacity: 1, offset: 0.3 }, { opacity: 0, transform: "translateX(30px)" }], at, d(0.35), "linear");
  const look = gateLook(gate);
  const target = look === "stopped" ? el.fail : look === "flagged" ? el.warn : look === "passed" ? el.pass : undefined;
  if (target) tl.to(target, [{ opacity: 0 }, { opacity: 1 }], at + 0.35, d(0.3));
  if (look === "passed") tl.to(el.check, [{ opacity: 0, transform: "scale(.5)" }, { opacity: 1, transform: "scale(1)" }], at + 0.4, d(0.3));
  if (look === "stopped" || (look === "flagged" && stopping)) doorsClose(tl, el, at + 0.35, d);
}

function doorsClose(tl: Timeline, el: GateEls, at: number, d: (n: number) => number) {
  tl.to(el.doors[0], [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], at, d(0.12), "cubic-bezier(.7,0,.84,0)");
  tl.to(el.doors[1], [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], at, d(0.12), "cubic-bezier(.7,0,.84,0)");
  tl.to(el.inner, [{ transform: "translateX(0)" }, { transform: "translateX(2px)" }, { transform: "translateX(-2px)" }, { transform: "translateX(0)" }], at + 0.12, d(0.2), "linear");
}

function arrive(tl: Timeline, L: LaneEls, at: number, lostCents: number, d: (n: number) => number, _attacker: boolean) {
  tl.to(L.destPulse, [{ opacity: 0.9, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.5)" }], at, d(0.6), "ease-out");
  tl.track((t) => {
    const p = span(t, at, d(0.6));
    L.destCount.textContent = p > 0 && lostCents ? `+${usd(Math.round(lostCents * p))}` : "";
    L.balance.textContent = usd(START_CENTS - Math.round(lostCents * p));
  });
  tl.to(L.capsule, [{ opacity: 1 }, { opacity: 0 }], at + 0.3, d(0.3));
  L.doneAt = at;
}

function home(tl: Timeline, L: LaneEls, at: number, d: (n: number) => number) {
  tl.to(L.capsule.querySelector(".vr-cap-glow"), [{ fill: "url(#vr-glow)" }, { fill: "url(#vr-glow-mint)" }], at, d(0.2));
  tl.to(L.vaultDoor, [{ transform: "rotate(40deg)" }, { transform: "rotate(0deg)" }], at, d(0.4));
  tl.to(L.capsule, [{ opacity: 1 }, { opacity: 0 }], at + 0.2, d(0.3));
  L.doneAt = at;
}

/** What the lane ended with, from the referee: the same words whatever the capsule did. */
function settle(tl: Timeline, L: LaneEls, st: LaneStory, id: LaneId, at: number) {
  const lost = usd(st.lostCents).replace(/\.00$/, "");
  const [main, sub, tone] =
    st.outcome === "lost" ? [`Lost ${lost}`, st.requests > 1 ? `over ${st.requests} requests` : st.owner === "approved" ? "the owner approved it" : id === "caps-only" && st.gates[0]?.status === "pass" ? "under the cap" : "", "bad"]
    : st.outcome === "key" ? ["Key added", "an attacker can sign", "bad"]
    : st.outcome === "stopped" ? ["Money safe", id === "sealed" && st.stopAt !== null ? `stopped at check ${st.stopAt + 1}` : id === "caps-only" ? "over the limit" : "", "good"]
    : st.outcome === "owner-rejected" ? ["Money safe", "the owner said no", "good"]
    : st.outcome === "owner-approved" ? ["Delivered", "the owner approved it", "good"]
    : st.outcome === "delivered" ? ["Delivered", "", "good"]
    : ["Not involved", "", ""];
  tl.track((t) => {
    const on = t >= at;
    L.resultMain.textContent = on ? main : "";
    L.resultSub.textContent = on ? sub : "";
    L.resultMain.classList.toggle("bad", on && tone === "bad");
    L.resultMain.classList.toggle("good", on && tone === "good");
    if (on) L.balance.textContent = usd(START_CENTS - st.lostCents);
  });
}

function reasonOf(g: Gate) {
  return g.codes.length ? `${reason(g.codes[0]!)}.` : "";
}

function verdictLine(c: StoryCase): string {
  const lost = LANE_ORDER.filter((l) => c.lanes[l].lostCents > 0);
  const keys = LANE_ORDER.filter((l) => c.lanes[l].keysAdded > 0 && !c.lanes[l].lostCents);
  if (c.kind === "everyday") return "The honest payment arrived in every lane.";
  if (c.outOfScope) return lost.length === 3 ? "All three lanes lost. This is beyond what a checker in front of a wallet can stop." : "SeIn could not hold this one.";
  const name = (l: LaneId) => (l === "sealed" ? "SeIn" : LANE_NAMES[l]);
  if (c.lanes.sealed.outcome === "lost") return `${lost.map(name).join(", ")} lost money. The owner approved it.`;
  if (keys.length) return `${keys.map(name).join(" and ")} left an attacker key in the wallet. SeIn added none.`;
  if (lost.length === 2) return `Two lanes lost ${usd(c.lanes["no-guard"].lostCents).replace(/\.00$/, "")}. SeIn lost nothing.`;
  if (lost.length === 1) return `${name(lost[0]!)} lost ${usd(c.lanes[lost[0]!].lostCents).replace(/\.00$/, "")}. Limits and SeIn held.`;
  return "No lane lost money.";
}

function highlighted(text: string, ranges: [number, number][]): string {
  let out = "";
  let i = 0;
  for (const [a, b] of ranges) {
    out += esc(text.slice(i, a)) + `<mark>${esc(text.slice(a, b))}</mark>`;
    i = b;
  }
  return out + esc(text.slice(i));
}

function diffLine(a: string, b: string, cls: string): string {
  return `<span class="${cls}">${[...a].map((ch, i) => (ch !== b[i] ? `<em>${esc(ch)}</em>` : esc(ch))).join("")}</span>`;
}
