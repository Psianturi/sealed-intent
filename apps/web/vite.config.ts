import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { renderEscaped, renderFingerprints, renderHonesty, renderMeta, renderRows, renderScore, scopeOf, scopeSentence, usd, type Run } from "./src/arena-data";
import { mark, siteFooter, siteHeader } from "./src/shell";
import { renderCaseFiles, renderStageFallback, renderTally } from "./src/stage/static";
import { buildDeck } from "./src/game-data";
import { buildStoryboard } from "./src/storyboard";

/** The stage reads only these files, made from the official recordings. */
function writeStoryboards(): void {
  const out = resolve(__dirname, "public", "storyboard");
  mkdirSync(out, { recursive: true });
  for (const dir of ["official", "official-lazy", "official-sandbox"]) {
    const run = readRun(dir);
    if (!run) continue;
    const board = buildStoryboard(run, dir);
    writeFileSync(resolve(out, `${dir}.json`), JSON.stringify(board));
    // the game deals only from the official run
    if (dir === "official") writeFileSync(resolve(out, "game.json"), JSON.stringify(buildDeck(run, board)));
  }
}

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
    buildStart() {
      writeStoryboards();
    },
    transformIndexHtml(html) {
      const run = readRun("official");
      const lazy = readRun("official-lazy");
      const flowPath = resolve(__dirname, "..", "..", "evidence", "custody-testnet", "s4-flow.json");
      const flow = existsSync(flowPath) ? JSON.parse(readFileSync(flowPath, "utf8")) : undefined;
      // the flow's payments, the payment around SeIn, and the signed owner approval
      const paid = flow ? flow.steps.filter((s: { txHash?: string }) => s.txHash).length + 1 + (existsSync(resolve(flowPath, "..", "approval", "approval.json")) ? 1 : 0) : 0;
      const parts: Record<string, string> = {
        ...(flow ? { "custody:found": String(flow.bypass.detectedSeconds), "custody:frozen": String(flow.bypass.frozenSeconds), "live:payments": String(paid) } : {}),
        "mark:18": mark(18),
        "header:home": siteHeader("home"),
        "header:arena": siteHeader("arena"),
        "header:verify": siteHeader("verify"),
        "header:agent": siteHeader("agent"),
        "header:approve": siteHeader("approve"),
        "header:limits": siteHeader("limits"),
        "header:proof": siteHeader("proof"),
        "header:start": siteHeader("start"),
        "header:checkup": siteHeader("checkup"),
        "header:try": siteHeader("try"),
        "footer:try": siteFooter("Test tokens only. The checks are real."),
        "footer:checkup": siteFooter("Read-only until you choose to heal. Not audited."),
        "footer:start": siteFooter("Start on testnet. Not audited."),
        "footer:proof": siteFooter("Every check on this page runs in your browser."),
        "footer:limits": siteFooter("Not audited. Do not use with funds you cannot lose."),
        "footer:approve": siteFooter("Your answer goes only to your own SeIn."),
        "footer:home": siteFooter("Not audited. Do not use with funds you cannot lose."),
        "footer:arena": siteFooter("Test tokens only. No real money moves in the Arena."),
        "footer:verify": siteFooter("Receipts are checked in your browser. Nothing is uploaded."),
      };
      if (run) {
        const s = scopeOf(run);
        const t = run.totals.sealed;
        const sb = buildStoryboard(run, "official");
        Object.assign(parts, {
          "case-files": renderCaseFiles(sb),
          tally: renderTally(sb),
          "stage-fallback": renderStageFallback(sb),
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
        approve: resolve(__dirname, "approve.html"),
        limits: resolve(__dirname, "limits.html"),
        proof: resolve(__dirname, "proof.html"),
        start: resolve(__dirname, "start.html"),
        checkup: resolve(__dirname, "checkup.html"),
        try: resolve(__dirname, "try.html"),
      },
    },
  },
});
