// The Arena page: the stage, its controls, and the parts below it.
import { esc, loadRun, renderEscaped, renderFingerprints, renderHonesty, renderMeta, renderScore, scopeSentence } from "./arena-data";
import { mountCase, type Mounted } from "./stage/stage";
import { renderTally } from "./stage/static";
import type { StoryCase, Storyboard } from "./storyboard";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const narrow = matchMedia("(max-width: 760px)");
const params = new URLSearchParams(location.search);
const present = params.get("present") === "1";
const boards: Record<string, Storyboard> = {};
let base = params.get("run") === "official-sandbox" ? "official-sandbox" : "official";
let ownerReads = true;
let index = 0;
let mounted: Mounted | undefined;
let autoplayed = false;
// before the first Play the stage shows the finished frame, like a poster
let poster = false;

const board = () => boards[ownerReads ? base : "official-lazy"] ?? boards[base]!;
const order = () => (present ? board().featured : board().cases.map((c) => c.id));
const caseAt = (i: number): StoryCase => board().cases.find((c) => c.id === order()[(i + order().length) % order().length])!;

async function load(dir: string): Promise<Storyboard | undefined> {
  if (boards[dir]) return boards[dir];
  const res = await fetch(`/storyboard/${dir}.json`).catch(() => undefined);
  if (!res?.ok) return undefined;
  return (boards[dir] = (await res.json()) as Storyboard);
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function mount(i: number, play = false) {
  mounted?.destroy();
  index = (i + order().length) % order().length;
  const c = caseAt(index);
  const next = caseAt(index + 1);
  const all = board().cases.filter((x) => x.kind === "attack");
  mounted = mountCase({ screen: $("vr-screen"), caption: $("vr-caption"), chapters: $("vr-chapters"), title: $("vr-title"), next: $("vr-nextcase") }, board(), c, {
    mobile: narrow.matches,
    reduced: reduced.matches,
    index: Math.max(all.indexOf(c) + 1, 0),
    total: all.length,
    verifyHref: c.receipt ? `/verify.html?replay=${encodeURIComponent(board().dir)}&r=${c.receipt.decisionId}` : undefined,
    next,
  });
  const tl = mounted.timeline;
  const scrub = $<HTMLInputElement>("vr-scrub");
  tl.rate = Number($<HTMLSelectElement>("vr-speed").value);
  tl.onTick = (t) => {
    scrub.value = String(Math.round((t / tl.duration) * 1000));
    $("vr-time").textContent = `${fmt(t)} / ${fmt(tl.duration)}`;
    const btn = $("vr-play");
    btn.textContent = tl.playing ? "Pause" : t >= tl.duration ? "Replay" : "Play";
    btn.setAttribute("aria-label", btn.textContent);
  };
  tl.onEnd = () => {
    tl.onTick?.(tl.time);
    if (present) setTimeout(() => mount(index + 1, true), 1600);
  };
  tl.onTick(0);
  if (play) tl.play();
  else {
    const verdict = mounted.acts.find(([n]) => n === "Verdict")?.[1] ?? 0;
    tl.seek(verdict + 1.2);
    poster = true;
  }
}

function start() {
  const tl = mounted?.timeline;
  if (!tl) return;
  if (poster) {
    poster = false;
    tl.seek(0);
  }
  tl.play();
}

function wire() {
  const stage = $("stage");
  $("vr-play").addEventListener("click", () => (mounted?.timeline.playing ? mounted.timeline.pause() : start()));
  $("vr-prev").addEventListener("click", () => mount(index - 1, true));
  $("vr-next").addEventListener("click", () => mount(index + 1, true));
  $("vr-skip").addEventListener("click", () => {
    const tl = mounted?.timeline;
    const at = mounted?.acts.find(([n]) => n === "Verdict")?.[1];
    if (tl && at !== undefined) (poster = false, tl.pause(), tl.seek(at), tl.play());
  });
  $<HTMLInputElement>("vr-scrub").addEventListener("input", (e) => {
    const tl = mounted?.timeline;
    if (!tl) return;
    poster = false;
    tl.pause();
    tl.seek((Number((e.target as HTMLInputElement).value) / 1000) * tl.duration);
  });
  $<HTMLSelectElement>("vr-speed").addEventListener("change", (e) => mounted && (mounted.timeline.rate = Number((e.target as HTMLSelectElement).value)));
  $<HTMLInputElement>("owner-reads").addEventListener("change", async (e) => {
    ownerReads = (e.target as HTMLInputElement).checked;
    await load("official-lazy");
    const id = caseAt(index).id;
    const warnCase = board().cases.find((c) => c.id === id && c.lanes.sealed.owner) ? id : board().cases.find((c) => c.lanes.sealed.owner)!.id;
    mount(order().indexOf(warnCase), true);
    renderTallies();
  });
  stage.addEventListener("keydown", (e) => {
    if (e.target !== stage) return;
    if (e.key === " ") (e.preventDefault(), $("vr-play").click());
    if (e.key === "ArrowRight") (e.preventDefault(), mount(index + 1, true));
    if (e.key === "ArrowLeft") (e.preventDefault(), mount(index - 1, true));
  });
  document.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-case]");
    if (!b) return;
    mount(order().indexOf(b.dataset.case!), true);
    stage.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
  });
  document.addEventListener("visibilitychange", () => document.hidden && mounted?.timeline.pause());
  $("vr-full").addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.requestFullscreen?.().catch(() => undefined);
  });
  document.addEventListener("fullscreenchange", () => {
    $("vr-full").setAttribute("aria-label", document.fullscreenElement ? "Exit full screen" : "Full screen");
    mount(index);
  });
  narrow.addEventListener("change", () => mount(index));
  // play the featured case once, when the stage first comes into view
  new IntersectionObserver(
    (entries) => {
      if (autoplayed || !entries.some((x) => x.isIntersecting) || document.hidden) return;
      autoplayed = true;
      start();
    },
    { threshold: 0.5 },
  ).observe(stage);
  $<HTMLSelectElement>("chainpick").value = base;
  $<HTMLSelectElement>("chainpick").addEventListener("change", async (e) => {
    base = (e.target as HTMLSelectElement).value;
    await load(base);
    const id = caseAt(index).id;
    mount(Math.max(order().indexOf(id), 0));
    renderTallies();
  });
}

async function renderTallies() {
  const dir = ownerReads ? base : "official-lazy";
  $("tally").innerHTML = renderTally(board());
  const run = await loadRun(`/replays/${dir}`).catch(() => undefined);
  if (!run) return;
  $("score").innerHTML = renderScore(run);
  $("summary").textContent = scopeSentence(run);
  $("escaped").innerHTML = renderEscaped(run);
  $("honesty").innerHTML = `<tbody>${renderHonesty(run)}</tbody>`;
  $("run-meta").textContent = renderMeta(run);
  $("repro").innerHTML = renderFingerprints(run);
}

async function main() {
  if (present) document.body.classList.add("present");
  await Promise.all([load(base), load("official-lazy")]);
  if (!boards[base]) {
    $("vr-caption").innerHTML = `The recording could not be loaded. ${esc("Try reloading the page.")}`;
    return;
  }
  wire();
  const first = present ? 0 : Math.max(order().indexOf(params.get("case") ?? "S-MORSE"), 0);
  mount(first);
  if (present) start();
  if (base !== "official") renderTallies();
}
// lets an automated check jump to any moment
(window as unknown as { __seinStage?: () => Mounted | undefined }).__seinStage = () => mounted;
void main();
