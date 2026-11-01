// Copies the official recording and a sample receipt into public/ so the site is static.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const pub = resolve(here, "..", "public");
const officials = ["official", "official-sandbox"];
mkdirSync(join(pub, "replays"), { recursive: true });
for (const name of officials) if (existsSync(join(root, "replays", name))) cpSync(join(root, "replays", name), join(pub, "replays", name), { recursive: true });

// a real receipt from the offline demo, committed so the verify page always has a sample
const samples = join(pub, "samples");
mkdirSync(samples, { recursive: true });
cpSync(join(here, "..", "data", "sample-receipt.json"), join(samples, "receipt.json"));
console.log("web data prepared");
