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
const MARK = `<svg width="64" height="64" viewBox="0 0 64 64"><path d="M32.0 2.2L33.9 2.6L35.7 3.6L37.3 5.1L38.8 6.7L40.1 8.0L41.6 8.9L43.2 9.3L45.1 9.3L47.2 9.2L49.4 9.3L51.4 9.8L53.1 10.9L54.2 12.6L54.7 14.6L54.8 16.8L54.7 18.9L54.7 20.8L55.1 22.4L56.0 23.9L57.3 25.2L58.9 26.7L60.4 28.3L61.4 30.1L61.8 32.0L61.4 33.9L60.4 35.7L58.9 37.3L57.3 38.8L56.0 40.1L55.1 41.6L54.7 43.2L54.7 45.1L54.8 47.2L54.7 49.4L54.2 51.4L53.1 53.1L51.4 54.2L49.4 54.7L47.2 54.8L45.1 54.7L43.2 54.7L41.6 55.1L40.1 56.0L38.8 57.3L37.3 58.9L35.7 60.4L33.9 61.4L32.0 61.8L30.1 61.4L28.3 60.4L26.7 58.9L25.2 57.3L23.9 56.0L22.4 55.1L20.8 54.7L18.9 54.7L16.8 54.8L14.6 54.7L12.6 54.2L10.9 53.1L9.8 51.4L9.3 49.4L9.2 47.2L9.3 45.1L9.3 43.2L8.9 41.6L8.0 40.1L6.7 38.8L5.1 37.3L3.6 35.7L2.6 33.9L2.2 32.0L2.6 30.1L3.6 28.3L5.1 26.7L6.7 25.2L8.0 23.9L8.9 22.4L9.3 20.8L9.3 18.9L9.2 16.8L9.3 14.6L9.8 12.6L10.9 10.9L12.6 9.8L14.6 9.3L16.8 9.2L18.9 9.3L20.8 9.3L22.4 8.9L23.9 8.0L25.2 6.7L26.7 5.1L28.3 3.6L30.1 2.6Z" fill="#3b3f91"/><path d="M32 17.6a7.4 7.4 0 0 1 4.3 13.4l2.5 13.1a1.9 1.9 0 0 1-1.9 2.3h-9.8a1.9 1.9 0 0 1-1.9-2.3l2.5-13.1A7.4 7.4 0 0 1 32 17.6Z" fill="#f4efe6"/></svg>`;
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
body{width:370px;height:150px;background:transparent}.b{width:370px;height:150px;background:#fbf8f2;border-radius:24px;display:flex;align-items:center;gap:22px;padding:0 34px}
.w{font-size:64px;font-weight:700;letter-spacing:-.02em;line-height:1;color:#1d2330}.w span{color:#2b48b0}.t{font-size:17px;font-weight:600;letter-spacing:.14em;color:#55606d;margin-top:6px}svg{width:96px;height:96px}</style>
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
