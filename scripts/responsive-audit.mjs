// Opens every page at five widths in headless Chrome or Edge and fails on sideways scrolling or page errors.
//   node scripts/responsive-audit.mjs http://localhost:4173      (CHROME=/path/to/chrome to pick the browser)
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const base = (process.argv[2] ?? "http://localhost:4173").replace(/\/$/, "");
const PAGES = ["/", "/try.html", "/checkup.html", "/arena.html", "/arena.html#cases", "/arena.html#results", "/proof.html", "/verify.html", "/agent.html?id=agent-1", "/start.html", "/limits.html"];
const WIDTHS = [390, 768, 1024, 1366, 1920];

function browser() {
  if (process.env.CHROME) return process.env.CHROME;
  const known = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = known.find(existsSync);
  if (found) return found;
  const cache = join(homedir(), ".cache", "ms-playwright");
  for (const dir of existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("chromium")) : []) {
    for (const exe of ["chrome-linux/chrome", "chrome-linux64/chrome"]) if (existsSync(join(cache, dir, exe))) return join(cache, dir, exe);
  }
  try {
    return execSync("command -v google-chrome || command -v chromium", { shell: "/bin/sh" }).toString().trim();
  } catch {
    throw new Error("No Chrome or Edge found. Set CHROME, or run: npx playwright install chromium");
  }
}

const port = 9700 + Math.floor(Math.random() * 200);
const proc = spawn(browser(), ["--headless=new", "--no-sandbox", "--hide-scrollbars", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "audit-"))}`, "about:blank"], { stdio: "ignore" });
// never leave a browser behind, even when a page hangs or the run is interrupted
const stopBrowser = () => {
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: "ignore" });
    else proc.kill();
  } catch {}
};
setTimeout(() => { stopBrowser(); console.log("Stopped: the audit ran longer than 12 minutes"); process.exit(1); }, 12 * 60_000).unref();
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { stopBrowser(); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch {}
  if (!ws) await sleep(500);
}
if (!ws) throw new Error("The browser did not start");
await new Promise((r) => (ws.onopen = r));
let n = 0;
const waiting = new Map();
const errors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description?.split("\n")[0] ?? "exception");
  if (msg.id && waiting.has(msg.id)) (waiting.get(msg.id)(msg), waiting.delete(msg.id));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++n; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
await send("Page.enable");
await send("Runtime.enable");

let failed = 0;
for (const p of PAGES) {
  for (const w of WIDTHS) {
    errors.length = 0;
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
    await send("Page.navigate", { url: "about:blank" });
    await send("Page.navigate", { url: base + p });
    await sleep(2200);
    const r = await ev(`(() => {
      const W = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > W + 1 && getComputedStyle(e).position !== 'fixed'; })
        .filter(e => !e.closest('.table-wrap, [style*="overflow"]') && !(e.ownerSVGElement))
        .slice(0, 4).map(e => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '') + ' ' + Math.round(e.getBoundingClientRect().right) + 'px');
      return { scroll: document.documentElement.scrollWidth, W, height: document.documentElement.scrollHeight, wide };
    })()`);
    const bad = r.scroll > r.W + 1 || r.wide.length > 0 || errors.length > 0;
    if (bad) failed++;
    console.log(`${bad ? "FAIL" : "ok  "} ${p.padEnd(24)} ${String(w).padStart(4)}  height ${String(r.height).padStart(5)}${r.scroll > r.W + 1 ? `  scrolls sideways (${r.scroll})` : ""}${r.wide.length ? "  wide: " + r.wide.join(", ") : ""}${errors.length ? "  error: " + errors[0] : ""}`);
  }
}
ws.close();
stopBrowser();
console.log(failed ? `${failed} checks failed` : "All pages fit at every width");
process.exit(failed ? 1 : 0);
