import { loadRun, renderScore, type LaneId } from "./arena-data";

const el = document.getElementById("score")!;
const note = document.getElementById("score-note")!;
loadRun("/replays/official")
  .then((run) => {
    el.innerHTML = renderScore(run);
    const lanes: LaneId[] = ["no-guard", "caps-only", "sealed"];
    const n = run.outcomes.length;
    const t = run.totals;
    note.textContent = `${n} scenarios, ${t.sealed.legitTotal} legit tasks per lane, test tokens on a simulated ledger. Escaped through Sealed Intent: ${t.sealed.escaped.length} of ${n}, all of them attacks that bypass the checker by design. ${lanes.map((l) => `${l}: $${(t[l].stolenCents / 100).toFixed(2)} lost`).join(" · ")}.`;
  })
  .catch(() => {
    el.innerHTML = `<div class="lane"><h4>No recorded run</h4><p class="note">Run <code>pnpm arena:run</code> and copy the result to <code>replays/official</code>.</p></div>`;
  });
