// Copies the official recording and a sample receipt into public/ so the site is static.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const pub = resolve(here, "..", "public");
const official = join(root, "replays", "official");
mkdirSync(join(pub, "replays"), { recursive: true });
if (existsSync(official)) cpSync(official, join(pub, "replays", "official"), { recursive: true });

// one real-looking sample receipt for the verify page: the first BLOCK receipt from the official run, if any
const samples = join(pub, "samples");
mkdirSync(samples, { recursive: true });
const outDir = join(root, "out", "receipts");
if (existsSync(outDir)) {
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const r = JSON.parse(readFileSync(join(outDir, f), "utf8"));
    if (r.version === "sealed-intent/receipt@1" && r.verdict === "BLOCK" && r.tee) {
      writeFileSync(join(samples, "receipt.json"), JSON.stringify(r, null, 2));
      break;
    }
  }
}
console.log("web data prepared");
