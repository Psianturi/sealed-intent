// Renders public/og.png from the Arena stage: the finished frame of the featured case, with its title.
// Run by hand after a new official recording, with a preview server up:
//   node apps/web/scripts/og-stage.mjs http://localhost:4181/arena.html?case=S-MORSE apps/web/public/og.png
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, out] = process.argv.slice(2);
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const port = 9338;
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "edge-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  if (!ws) await sleep(500);
}
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && waiting.has(msg.id)) (waiting.get(msg.id)(msg), waiting.delete(msg.id)); };
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.result.value;
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1462, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(3500);
await ev(`(() => { const s = window.__seinStage(); s.timeline.pause(); const v = s.acts.find(a => a[0] === "Verdict")[1]; s.timeline.seek(v + 1.4); return true; })()`);
await sleep(400);
const r = await ev(`(() => { const s = document.getElementById("vr-screen").getBoundingClientRect(); const t = document.getElementById("vr-title").getBoundingClientRect(); const x = t.x - 14; const w = s.right + 14 - x; return { x, y: t.y - 10, w, h: w * 630 / 1200 }; })()`);
console.log("screen rect", JSON.stringify(r));
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1200 / r.w } });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
ws.close();
proc.kill();
process.exit(0);
