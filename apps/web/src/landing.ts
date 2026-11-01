import { loadRun, renderScore, usd } from "./arena-data";
import { mountFlow, mountHero, mountReceipt } from "./hero";

mountHero(document.getElementById("hero-anim")!);
mountFlow(document.getElementById("flow")!);
mountReceipt(document.getElementById("receipt-anim")!);

const el = document.getElementById("score")!;
const note = document.getElementById("score-note")!;
loadRun("/replays/official")
  .then((run) => {
    el.innerHTML = renderScore(run);
    const t = run.totals;
    const n = run.outcomes.length;
    note.textContent = `${n} attack scenarios, each mixed with ${t.sealed.legitTotal / n} everyday tasks. The unguarded agent lost ${usd(t["no-guard"].stolenCents)}, the one with spending limits ${usd(t["caps-only"].stolenCents)}, the one behind Sealed Intent ${usd(t.sealed.stolenCents)}, while finishing every legitimate task. The ${t.sealed.escaped.length} that got through are attacks no checker can stop: a stolen key, a bug in a token contract, a compromised checker, a lying data source. Test tokens; no real money.`;
  })
  .catch(() => {
    el.innerHTML = `<div class="lane"><h4>The official run is not available right now.</h4></div>`;
  });
