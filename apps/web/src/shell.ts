// Shared page chrome, injected at build time so the HTML is complete without JavaScript.
export function mark(size: number): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><rect x="3" y="3" width="58" height="58" rx="15" fill="#2747c4"/><path d="M30.5 21.5C28 14.5 11 14.5 11 24C11 33.5 31 30 31 40C31 49.5 13.5 50 9.5 42.5" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/><path d="M38 15.5H54M46 15.5V48.5M38 48.5H54" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/></svg>`;
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
// runs at the top of the body, so the saved theme is set before anything is drawn
const THEME_SCRIPT = `<script>(function(){var r=document.documentElement;try{if(localStorage.getItem("sein-theme")==="light")r.dataset.theme="light"}catch(e){}document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-theme-toggle]");if(!b)return;var light=r.dataset.theme!=="light";if(light)r.dataset.theme="light";else delete r.dataset.theme;try{localStorage.setItem("sein-theme",light?"light":"dark")}catch(e){}})})()</script>`;

export function siteHeader(current: string): string {
  const here = PARENT[current] ?? current;
  const links = NAV.map(([id, href, label]) => `<a href="${href}"${id === here ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<header class="top"><div class="top-in"><a class="brand" href="/" aria-label="SeIn, short for Sealed Intent, home">${mark(30)}${WORDMARK}</a><nav aria-label="Main">${links}</nav>${THEME_TOGGLE}</div></header>${THEME_SCRIPT}`;
}

const FOOT_LINKS = `<nav class="foot-links" aria-label="More"><a href="/start">Protect your own agent</a><a href="/verify.html">Verify a receipt</a><a href="/a/agent-1">Agent profile</a><a href="/limits.html">Limits and threat model</a><a href="https://github.com/Psianturi/sealed-intent">Source code</a><a href="https://github.com/Psianturi/sealed-intent#run-sein-for-your-own-agent">Integrate your agent</a></nav>`;

export function siteFooter(note: string): string {
  return `<footer><div class="foot-brand">${mark(22)}${WORDMARK}<span class="foot-full">Sealed Intent</span></div><p>Built at NEAR HACKATHON, November 2026. ${note}</p>${FOOT_LINKS}</footer>`;
}
