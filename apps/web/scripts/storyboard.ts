// pnpm arena:storyboard: what the stage will show, built from the official recordings.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStoryboard, gateLook } from "../src/storyboard";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const out = resolve(here, "..", "public", "storyboard");
mkdirSync(out, { recursive: true });
for (const dir of ["official", "official-lazy", "official-sandbox"]) {
  const base = join(root, "replays", dir);
  if (!existsSync(base)) continue;
  const get = (f: string) => JSON.parse(readFileSync(join(base, f), "utf8"));
  const sb = buildStoryboard({ manifest: get("manifest.json"), outcomes: get("outcomes.json"), totals: get("referee.json") }, dir);
  writeFileSync(join(out, `${dir}.json`), JSON.stringify(sb, null, 1));
  console.log(`\n${dir}: ${sb.cases.length} cases, SeIn stopped ${sb.totals.sealed.stoppedIn} of ${sb.totals.sealed.inScope} in scope`);
  for (const c of sb.cases) console.log(`  ${c.id.padEnd(18)} ${c.lanes.sealed.gates.map((g) => gateLook(g)[0]).join("")}  ${["no-guard", "caps-only", "sealed"].map((l) => c.lanes[l as "sealed"].outcome).join(" / ")}  ${c.moment.kind}`);
}
