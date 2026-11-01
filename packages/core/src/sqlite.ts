import { createRequire } from "node:module";

// node:sqlite is built into Node >= 22.5 but still prints an ExperimentalWarning.
// Silence only that warning, then load it.
const originalEmit = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === "string" ? warning : warning?.message;
  if (msg && msg.includes("SQLite")) return;
  return (originalEmit as (...a: unknown[]) => void).call(process, warning, ...rest);
}) as typeof process.emitWarning;

const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as typeof import("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = InstanceType<typeof sqlite.DatabaseSync>;
