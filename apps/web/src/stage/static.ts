// Static HTML for the Arena page, written at build time from the storyboard: readable without JavaScript.
import { LANE_NAMES, LANES, usd, type LaneId } from "../arena-data";
import { reason } from "../copy";
import type { LaneStory, StoryCase, Storyboard } from "../storyboard";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const GROUPS: [string, (c: StoryCase) => boolean][] = [
  ["Baseline: an honest payment", (c) => c.kind === "everyday"],
  ["Tricked by a message", (c) => !c.outOfScope && c.group === "fooled"],
  ["The wrong receiver", (c) => !c.outOfScope && c.id === "S-LOOKALIKE"],
  ["Too much at once", (c) => !c.outOfScope && c.id === "S-WHOLE-BALANCE"],
  ["A bad deal", (c) => !c.outOfScope && c.group === "price"],
  ["A dangerous action hidden inside", (c) => !c.outOfScope && (c.group === "tool" || c.group === "signing")],
  ["A breached request path", (c) => !c.outOfScope && c.group === "breach"],
  ["Out of scope by design", (c) => c.outOfScope],
];

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
  const chips = LANES.map((l: LaneId) => {
    const [text, cls] = laneText(c.lanes[l]);
    return `<li><span>${LANE_NAMES[l]}</span><span class="chip ${cls}">${esc(text)}</span></li>`;
  }).join("");
  const why = c.lanes.sealed.codes.length ? `<p class="case-why">${esc([...new Set(c.lanes.sealed.codes)].slice(0, 2).map(reason).join(". "))}.</p>` : "";
  return `<article class="case-card${c.outOfScope ? " oos" : ""}"><button type="button" class="case-play" data-case="${esc(c.id)}" aria-label="Play ${esc(c.title)} on the stage"><h4>${esc(c.title)}</h4><p class="note">${c.pattern ? `${esc(c.pattern.incident)}, ${esc(c.pattern.date)}` : c.kind === "everyday" ? "No attack" : "Hypothetical"}</p><p class="case-sum">${esc(c.summary)}</p><ul class="case-lanes">${chips}</ul>${why}</button></article>`;
}

export function renderCaseFiles(sb: Storyboard): string {
  return GROUPS.map(([name, test]) => {
    const list = sb.cases.filter(test);
    return list.length ? `<section class="case-group"><h3>${esc(name)}</h3><div class="case-grid">${list.map(card).join("")}</div></section>` : "";
  }).join("");
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

/** For readers and crawlers without JavaScript: the featured case, told in words. */
export function renderStageFallback(sb: Storyboard): string {
  const c = sb.cases.find((x) => x.id === "S-MORSE") ?? sb.cases[0]!;
  const lines = LANES.map((l) => `<li><b>${LANE_NAMES[l]}:</b> ${esc(laneText(c.lanes[l])[0])}.</li>`).join("");
  return `<div class="vr-fallback"><p><b>${esc(c.title)}.</b> ${esc(c.summary)}</p><ul>${lines}</ul></div>`;
}
