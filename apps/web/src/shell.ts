// Shared page chrome, injected at build time so the HTML is complete without JavaScript.
// The mark is a wax seal with a keyhole: the rules are sealed, and only the owner holds the key.
const SEAL = "M32.0 2.2L33.9 2.6L35.7 3.6L37.3 5.1L38.8 6.7L40.1 8.0L41.6 8.9L43.2 9.3L45.1 9.3L47.2 9.2L49.4 9.3L51.4 9.8L53.1 10.9L54.2 12.6L54.7 14.6L54.8 16.8L54.7 18.9L54.7 20.8L55.1 22.4L56.0 23.9L57.3 25.2L58.9 26.7L60.4 28.3L61.4 30.1L61.8 32.0L61.4 33.9L60.4 35.7L58.9 37.3L57.3 38.8L56.0 40.1L55.1 41.6L54.7 43.2L54.7 45.1L54.8 47.2L54.7 49.4L54.2 51.4L53.1 53.1L51.4 54.2L49.4 54.7L47.2 54.8L45.1 54.7L43.2 54.7L41.6 55.1L40.1 56.0L38.8 57.3L37.3 58.9L35.7 60.4L33.9 61.4L32.0 61.8L30.1 61.4L28.3 60.4L26.7 58.9L25.2 57.3L23.9 56.0L22.4 55.1L20.8 54.7L18.9 54.7L16.8 54.8L14.6 54.7L12.6 54.2L10.9 53.1L9.8 51.4L9.3 49.4L9.2 47.2L9.3 45.1L9.3 43.2L8.9 41.6L8.0 40.1L6.7 38.8L5.1 37.3L3.6 35.7L2.6 33.9L2.2 32.0L2.6 30.1L3.6 28.3L5.1 26.7L6.7 25.2L8.0 23.9L8.9 22.4L9.3 20.8L9.3 18.9L9.2 16.8L9.3 14.6L9.8 12.6L10.9 10.9L12.6 9.8L14.6 9.3L16.8 9.2L18.9 9.3L20.8 9.3L22.4 8.9L23.9 8.0L25.2 6.7L26.7 5.1L28.3 3.6L30.1 2.6Z";
const KEYHOLE = "M32 17.6a7.4 7.4 0 0 1 4.3 13.4l2.5 13.1a1.9 1.9 0 0 1-1.9 2.3h-9.8a1.9 1.9 0 0 1-1.9-2.3l2.5-13.1A7.4 7.4 0 0 1 32 17.6Z";
export function mark(size: number): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><path class="mark-seal" d="${SEAL}"/><path class="mark-cut" d="${KEYHOLE}"/></svg>`;
}

export const WORDMARK = `<span class="word">Se<b>I</b><span class="n">n</span></span>`;

const NAV: [string, string, string][] = [
  ["home", "/", "Overview"],
  ["try", "/try", "Try it"],
  ["checkup", "/checkup", "Checkpoint"],
  ["arena", "/arena.html", "Arena"],
  ["proof", "/proof", "Proof"],
];
// pages without their own tab light up the tab they belong to
const PARENT: Record<string, string> = { verify: "proof", agent: "proof", limits: "proof", approve: "home" };

const THEME_TOGGLE = `<button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch between dark and light" title="Dark or light"><svg class="moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg><svg class="sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>`;
// goes in the head, so the theme is set before anything is drawn; light unless the visitor chose dark
export const THEME_HEAD = `<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet" /><script>(function(){var r=document.documentElement,t="light";try{t=localStorage.getItem("sein-theme")==="dark"?"dark":"light"}catch(e){}r.dataset.theme=t;function paint(){var m=document.querySelector('meta[name="theme-color"]');m&&m.setAttribute("content",t==="dark"?"#06080f":"#f4efe6")}document.addEventListener("DOMContentLoaded",paint);document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-theme-toggle]");if(!b)return;t=r.dataset.theme==="dark"?"light":"dark";function go(){r.dataset.theme=t;paint();try{localStorage.setItem("sein-theme",t)}catch(e){}document.dispatchEvent(new CustomEvent("sein:theme",{detail:t}))}var q=b.getBoundingClientRect();r.style.setProperty("--tx",q.left+q.width/2+"px");r.style.setProperty("--ty",q.top+q.height/2+"px");if(document.startViewTransition&&!matchMedia("(prefers-reduced-motion: reduce)").matches)document.startViewTransition(go);else go()})})()</script>`;

export function siteHeader(current: string): string {
  const here = PARENT[current] ?? current;
  const links = NAV.map(([id, href, label]) => `<a href="${href}"${id === here ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<header class="top"><div class="top-in"><a class="brand" href="/" aria-label="SeIn, short for Sealed Intent, home">${mark(34)}${WORDMARK}</a><nav aria-label="Main">${links}</nav>${THEME_TOGGLE}</div></header>`;
}

const FOOT_LINKS = `<nav class="foot-links" aria-label="More"><a href="/start">Protect your own agent</a><a href="/verify.html">Verify a receipt</a><a href="/a/agent-1">Agent profile</a><a href="/limits.html">Limits and threat model</a></nav>`;

export function siteFooter(note: string): string {
  return `<footer><div class="foot-brand">${mark(22)}${WORDMARK}<span class="foot-full">Sealed Intent</span></div><p>Built at NEAR HACKATHON, November 2026. ${note}</p>${FOOT_LINKS}</footer>`;
}
