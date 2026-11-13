// Renders public/logo.png (README) with a local Chromium browser. The link preview og.png now comes from og-stage.mjs.
// Run by hand after a new official recording: node apps/web/scripts/og.mjs   (BROWSER=/path/to/chrome to override)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const BROWSER = process.env.BROWSER ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const read = (f) => JSON.parse(readFileSync(join(root, "replays", "official", f), "utf8"));
const outcomes = read("outcomes.json");
const usd = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inScope = outcomes.filter((o) => o.scenario.expectedSealed !== "ESCAPES");
const lane = (l) => {
  const hit = (o) => o.lanes[l].verdict.stolenCents > 0 || o.lanes[l].verdict.foreignKeys.length > 0;
  return { stopped: inScope.filter((o) => !hit(o)).length, lost: inScope.reduce((n, o) => n + o.lanes[l].verdict.stolenCents, 0) };
};
const MARK = `<svg width="64" height="64" viewBox="0 0 64 64"><defs><linearGradient id="sein-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3ee6d0"/><stop offset="1" stop-color="#6e8bff"/></linearGradient></defs><path d="M32 5 55 12.5V30C55 44.5 45.5 54.5 32 59.5 18.5 54.5 9 44.5 9 30V12.5Z" fill="url(#sein-g)" stroke="url(#sein-g)" stroke-width="4" stroke-linejoin="round"/><path d="M40.5 24C39.3 19.6 35.8 17.5 31.6 17.5 26.6 17.5 23 20.4 23 24.6 23 33.4 41 29.4 41 38.8 41 43.4 37.2 46.5 32 46.5 27.4 46.5 24 44.4 22.6 40.6" fill="none" stroke="#06101f" stroke-width="6.2" stroke-linecap="round"/></svg>`;
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;600;700&display=swap" rel="stylesheet"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&text=I&display=swap" rel="stylesheet">`;
const BASE = `*{box-sizing:border-box}html,body{margin:0;font-family:"IBM Plex Sans","Instrument Sans",system-ui,sans-serif}`;

const card = (name, l, hero) => {
  const c = lane(l);
  return `<div class="c${hero ? " hero" : ""}"><h3>${name}</h3><p class="n">${c.stopped} of ${inScope.length}</p><p class="s">attacks in scope stopped</p><p class="m">${usd(c.lost)} lost</p></div>`;
};
const og = `<!doctype html><meta charset="utf-8">${FONTS}<style>${BASE}
body{width:1200px;height:630px;background:#0e1a4a;color:#eef1ff;padding:48px 56px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:16px}.w{font-size:36px;font-weight:700;letter-spacing:-.02em}.w span{color:#9fb3ff}
h1{font-size:58px;line-height:1.05;letter-spacing:-.025em;margin:26px 0 30px}
.g{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.c{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);border-radius:18px;padding:20px 24px}
.c.hero{background:#fff;color:#141a21;border-color:#fff}.c h3{margin:0 0 6px;font-size:22px}.n{margin:0;font-size:46px;font-weight:700;letter-spacing:-.02em;line-height:1.05}
.s{margin:4px 0 0;font-size:18px;opacity:.85}.m{margin:6px 0 0;font-size:20px;font-weight:600}
.f{margin-top:auto;font-size:18px;color:#b7c0e6}</style>
<div class="top">${MARK}<div class="w">Se<span>In</span></div></div>
<h1>Your AI agent can ask for money.<br>It can't take it.</h1>
<div class="g">${card("No guard", "no-guard")}${card("Limits only", "caps-only")}${card("SeIn", "sealed", true)}</div>
<p class="f">Three identical agents, the same attacks, a referee that reads only on-chain state. Test tokens in a recorded simulation.</p>`;
const logo = `<!doctype html><meta charset="utf-8">${FONTS}<style>${BASE}
body{width:370px;height:150px;background:transparent}.b{width:370px;height:150px;background:#fff;border-radius:24px;display:flex;align-items:center;gap:22px;padding:0 34px}
.w{font-size:64px;font-weight:700;letter-spacing:-.02em;line-height:1;color:#141a21}.w span{color:#1f3aa3}.t{font-size:17px;font-weight:600;letter-spacing:.14em;color:#55606d;margin-top:6px}svg{width:96px;height:96px}</style>
<div class="b">${MARK}<div><div class="w">Se<span>In</span></div><div class="t">SEALED INTENT</div></div></div>`;

const dir = mkdtempSync(join(tmpdir(), "sein-og-"));
const port = 9334;
const proc = spawn(BROWSER, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, "profile")}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
  } catch {}
  if (!target) await sleep(500);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (waiting.has(msg.id)) {
    waiting.get(msg.id)(msg);
    waiting.delete(msg.id);
  }
};
const send = (method, params = {}) => new Promise((res) => (waiting.set(++id, res), ws.send(JSON.stringify({ id, method, params }))));

async function render(html, width, height, scale, out) {
  const file = join(dir, `${out}.html`);
  writeFileSync(file, html);
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send("Page.navigate", { url: pathToFileURL(file).href });
  await sleep(3500);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(here, "..", "public", out), Buffer.from(shot.result.data, "base64"));
  console.log("wrote", out);
}
await send("Page.enable");
await render(og, 1200, 630, 1, "og.png");
await render(logo, 370, 150, 2, "logo.png");
ws.close();
proc.kill();
process.exit(0);
