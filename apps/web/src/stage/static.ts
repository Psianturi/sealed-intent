// Static HTML for the Arena page, written at build time from the storyboard: readable without JavaScript.
import { LANE_NAMES, LANES, usd, type LaneId } from "../arena-data";
import { reason } from "../copy";
import type { LaneStory, StoryCase, Storyboard } from "../storyboard";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// key, filter label, card label, test
export const GROUPS: [string, string, string, (c: StoryCase) => boolean][] = [
  ["tricked", "Tricked", "Tricked by a message", (c) => !c.outOfScope && c.group === "fooled"],
  ["mistake", "Wrong receiver", "Wrong receiver or too much", (c) => !c.outOfScope && c.group === "mistake"],
  ["deal", "Bad deal", "A bad deal", (c) => !c.outOfScope && c.group === "price"],
  ["hidden", "Hidden action", "A dangerous action hidden inside", (c) => !c.outOfScope && (c.group === "tool" || c.group === "signing")],
  ["breach", "Breached path", "A breached request path", (c) => !c.outOfScope && c.group === "breach"],
  ["honest", "Honest payment", "Baseline: an honest payment", (c) => c.kind === "everyday"],
  ["oos", "Beyond any guard", "Out of scope by design", (c) => !!c.outOfScope],
];
const groupOf = (c: StoryCase) => GROUPS.find(([, , , test]) => test(c)) ?? GROUPS[GROUPS.length - 1]!;

export function laneText(st: LaneStory): [string, string] {
  if (st.outcome === "lost") return [`Lost ${usd(st.lostCents).replace(/\.00$/, "")}`, "lost"];
  if (st.outcome === "key") return ["Key added", "key"];
  if (st.outcome === "stopped") return ["Stopped", "block"];
  if (st.outcome === "owner-rejected") return ["Owner said no", "warn"];
  if (st.outcome === "owner-approved") return ["Owner approved", "warn"];
  if (st.outcome === "delivered") return ["Delivered", "allow"];
  return ["Not involved", "sim"];
}

function card(c: StoryCase): string {
  const [key, , label] = groupOf(c);
  const chips = LANES.map((l: LaneId) => {
    const [text, cls] = laneText(c.lanes[l]);
    return `<li><span>${LANE_NAMES[l]}</span><span class="chip ${cls}">${esc(text)}</span></li>`;
  }).join("");
  const why = c.lanes.sealed.codes.length ? `<p class="case-why">${esc([...new Set(c.lanes.sealed.codes)].slice(0, 2).map(reason).join(". "))}.</p>` : "";
  const source = c.pattern ? `${esc(c.pattern.incident)}, ${esc(c.pattern.date)}` : c.kind === "everyday" ? "No attack" : "Hypothetical";
  return `<article class="case-card${c.outOfScope ? " oos" : ""}" data-group="${key}"><button type="button" class="case-play" data-case="${esc(c.id)}" aria-label="Play ${esc(c.title)} on the stage"><span class="case-tag">${esc(label)}</span><h4>${esc(c.title)}</h4><p class="case-src">${source}</p><p class="case-sum">${esc(c.summary)}</p><ul class="case-lanes">${chips}</ul>${why}<span class="case-go">Play on the stage</span></button></article>`;
}

export function renderCaseFiles(sb: Storyboard): string {
  const count = (test: (c: StoryCase) => boolean) => sb.cases.filter(test).length;
  const filters = [`<button type="button" data-filter="all" aria-pressed="true">All <b>${sb.cases.length}</b></button>`]
    .concat(GROUPS.filter(([, , , t]) => count(t)).map(([key, short, , t]) => `<button type="button" data-filter="${key}" aria-pressed="false">${esc(short)} <b>${count(t)}</b></button>`))
    .join("");
  const order = GROUPS.flatMap(([, , , t]) => sb.cases.filter(t));
  return `<div class="case-filters" role="group" aria-label="Filter cases">${filters}</div><div class="case-grid">${[...new Set(order)].map(card).join("")}</div>`;
}

export function renderTally(sb: Storyboard): string {
  const max = Math.max(...LANES.map((l) => sb.totals[l].lostIn), 1);
  return `<div class="tally-bars">${LANES.map((l) => {
    const t = sb.totals[l];
    return `<div class="tally-row ${l}"><span class="tally-name">${LANE_NAMES[l]}</span><span class="tally-bar"><i style="--w:${(t.lostIn / max) * 100}%"></i></span><span class="tally-num">${usd(t.lostIn)}</span></div>`;
  }).join("")}</div>
  <dl class="tally-facts">
    <div><dt>${sb.totals.sealed.stoppedIn} of ${sb.totals.sealed.inScope}</dt><dd>attacks in scope stopped by SeIn</dd></div>
    <div><dt>${usd(sb.totals.sealed.lostIn)}</dt><dd>lost through SeIn to those attacks</dd></div>
    <div><dt>${sb.totals.sealed.legitDone} of ${sb.totals.sealed.legitTotal}</dt><dd>everyday tasks finished</dd></div>
    <div><dt>${sb.totals.sealed.falseBlocks}</dt><dd>honest payments blocked</dd></div>
    <div><dt>${sb.totals.sealed.outOfScope}</dt><dd>out of scope, shown on purpose</dd></div>
  </dl>`;
}

/** The result in one line, above the tabs: the reader sees the score first and wonders how. */
export function renderScoreStrip(sb: Storyboard): string {
  const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
  const t = sb.totals;
  return `<p class="ar-strip"><span><b>${t.sealed.inScope}</b> attacks</span><span class="lost">No guard lost <b>${money(t["no-guard"].lostIn)}</b></span><span class="lost">Limits only lost <b>${money(t["caps-only"].lostIn)}</b></span><span class="kept">SeIn lost <b>${money(t.sealed.lostIn)}</b></span><a href="#results">How it was counted</a></p>`;
}

/** For readers and crawlers without JavaScript: the featured case, told in words. */
export function renderStageFallback(sb: Storyboard): string {
  const c = sb.cases.find((x) => x.id === "S-MORSE") ?? sb.cases[0]!;
  const lines = LANES.map((l) => `<li><b>${LANE_NAMES[l]}:</b> ${esc(laneText(c.lanes[l])[0])}.</li>`).join("");
  return `<div class="vr-fallback"><p><b>${esc(c.title)}.</b> ${esc(c.summary)}</p><ul>${lines}</ul></div>`;
}
