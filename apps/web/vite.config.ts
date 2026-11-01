import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { renderEscaped, renderFingerprints, renderHonesty, renderMeta, renderRows, renderScore, scopeOf, scopeSentence, usd, type Run } from "./src/arena-data";
import { mark, siteFooter, siteHeader } from "./src/shell";

function readRun(name: string): Run | undefined {
  const dir = resolve(__dirname, "public", "replays", name);
  if (!existsSync(dir)) return undefined;
  const get = (f: string) => JSON.parse(readFileSync(resolve(dir, f), "utf8"));
  return { manifest: get("manifest.json"), outcomes: get("outcomes.json"), totals: get("referee.json") };
}

/** Writes the numbers into the HTML, so readers without JavaScript, crawlers and link previews see them. */
function staticContent(): Plugin {
  return {
    name: "sein-static-content",
    transformIndexHtml(html) {
      const run = readRun("official");
      const lazy = readRun("official-lazy");
      const flowPath = resolve(__dirname, "..", "..", "evidence", "custody-testnet", "s4-flow.json");
      const flow = existsSync(flowPath) ? JSON.parse(readFileSync(flowPath, "utf8")) : undefined;
      const parts: Record<string, string> = {
        ...(flow ? { "custody:found": String(flow.bypass.detectedSeconds), "custody:frozen": String(flow.bypass.frozenSeconds) } : {}),
        "mark:18": mark(18),
        "header:home": siteHeader("home"),
        "header:arena": siteHeader("arena"),
        "header:verify": siteHeader("verify"),
        "header:agent": siteHeader("agent"),
        "footer:home": siteFooter("Not audited. Do not use with funds you cannot lose."),
        "footer:arena": siteFooter("Test tokens only. No real money moves in the Arena."),
        "footer:verify": siteFooter("Receipts are checked in your browser. Nothing is uploaded."),
      };
      if (run) {
        const s = scopeOf(run);
        const t = run.totals.sealed;
        Object.assign(parts, {
          score: renderScore(run),
          "score-sentence": scopeSentence(run),
          rows: renderRows(run),
          escaped: renderEscaped(run),
          honesty: renderHonesty(run),
          meta: renderMeta(run),
          fingerprints: renderFingerprints(run),
          "stat:stopped": `${s.lanes.sealed.stoppedIn} of ${s.inScope}`,
          "stat:how": `${s.auto} blocked automatically, ${s.byOwner} rejected by the owner`,
          "stat:lost": usd(s.lanes.sealed.lostIn),
          "stat:lost-others": `No guard lost ${usd(s.lanes["no-guard"].lostIn)}. Limits only lost ${usd(s.lanes["caps-only"].lostIn)}.`,
          "stat:tasks": `${t.legitDone} of ${t.legitTotal}`,
          "stat:blocked": `${t.falseBlocks.length} honest payments blocked`,
          "stat:out": String(s.outOfScope),
        });
      }
      if (lazy) {
        const s = scopeOf(lazy);
        parts["stat:lazy"] = `If the owner approves everything without reading, ${s.inScope - s.lanes.sealed.stoppedIn} of the ${s.inScope} get through (${usd(s.lanes.sealed.lostIn)}).`;
      }
      return html.replace(/<!--([a-z-]+(?::[a-z0-9-]+)?)-->/g, (m, key: string) => parts[key] ?? m);
    },
  };
}

export default defineConfig({
  plugins: [staticContent()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        arena: resolve(__dirname, "arena.html"),
        verify: resolve(__dirname, "verify.html"),
        agent: resolve(__dirname, "agent.html"),
      },
    },
  },
});
