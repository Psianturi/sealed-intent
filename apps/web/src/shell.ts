// Shared page chrome, injected at build time so the HTML is complete without JavaScript.
export function mark(size: number): string {
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><rect x="3" y="3" width="58" height="58" rx="15" fill="#2747c4"/><path d="M30.5 21.5C28 14.5 11 14.5 11 24C11 33.5 31 30 31 40C31 49.5 13.5 50 9.5 42.5" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/><path d="M38 15.5H54M46 15.5V48.5M38 48.5H54" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/></svg>`;
}

export const WORDMARK = `<span class="word">Se<b>I</b><span class="n">n</span></span>`;

const NAV: [string, string, string][] = [
  ["home", "/", "Overview"],
  ["arena", "/arena.html", "Arena"],
  ["verify", "/verify.html", "Verify"],
  ["builders", "https://github.com/Psianturi/sealed-intent", "Builders"],
];

export function siteHeader(current: string): string {
  const links = NAV.map(([id, href, label]) => `<a href="${href}"${id === current ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `<header class="top"><a class="brand" href="/" aria-label="SeIn, short for Sealed Intent, home">${mark(30)}${WORDMARK}</a><nav aria-label="Main">${links}</nav></header>`;
}

export function siteFooter(note: string): string {
  return `<footer><div class="foot-brand">${mark(22)}${WORDMARK}<span class="foot-full">Sealed Intent</span></div><p>Built at NEAR HACKATHON, November 2026. ${note}</p></footer>`;
}
