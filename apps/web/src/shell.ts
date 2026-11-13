// Shared page chrome, injected at build time so the HTML is complete without JavaScript.
// The mark is a seal: twelve scallops, and inside it a payment (the dot) waiting at SeIn's gate (the bar).
export function mark(size: number): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><g class="mark-seal"><circle cx="32" cy="32" r="24.5" fill="none" stroke-width="10" stroke-dasharray="0 12.828" stroke-linecap="round"/><circle cx="32" cy="32" r="25" stroke="none"/></g><circle cx="32" cy="32" r="19" class="mark-ring"/><circle cx="24.6" cy="32" r="4.7" class="mark-cut"/><rect x="33.6" y="20.5" width="5.8" height="23" rx="2.9" class="mark-cut"/></svg>`;
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
  return `<header class="top"><div class="top-in"><a class="brand" href="/" aria-label="SeIn, short for Sealed Intent, home">${mark(30)}${WORDMARK}</a><nav aria-label="Main">${links}</nav>${THEME_TOGGLE}</div></header>`;
}

const FOOT_LINKS = `<nav class="foot-links" aria-label="More"><a href="/start">Protect your own agent</a><a href="/verify.html">Verify a receipt</a><a href="/a/agent-1">Agent profile</a><a href="/limits.html">Limits and threat model</a><a href="https://github.com/Psianturi/sealed-intent">Source code</a><a href="https://github.com/Psianturi/sealed-intent#run-sein-for-your-own-agent">Integrate your agent</a></nav>`;

export function siteFooter(note: string): string {
  return `<footer><div class="foot-brand">${mark(22)}${WORDMARK}<span class="foot-full">Sealed Intent</span></div><p>Built at NEAR HACKATHON, November 2026. ${note}</p>${FOOT_LINKS}</footer>`;
}
