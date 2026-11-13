// Shared page chrome, injected at build time so the HTML is complete without JavaScript.
export function mark(size: number): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="sein-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ee6d0"/><stop offset="1" stop-color="#6e8bff"/></linearGradient></defs><path d="M32 5 55 12.5V30C55 44.5 45.5 54.5 32 59.5 18.5 54.5 9 44.5 9 30V12.5Z" fill="url(#sein-g)" stroke="url(#sein-g)" stroke-width="4" stroke-linejoin="round"/><path d="M40.5 24C39.3 19.6 35.8 17.5 31.6 17.5 26.6 17.5 23 20.4 23 24.6 23 33.4 41 29.4 41 38.8 41 43.4 37.2 46.5 32 46.5 27.4 46.5 24 44.4 22.6 40.6" fill="none" stroke="#06101f" stroke-width="6.2" stroke-linecap="round"/></svg>`;
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
