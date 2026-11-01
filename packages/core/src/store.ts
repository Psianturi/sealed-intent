import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PrivateOpenings, Receipt } from "@sealed-intent/receipt";

/**
 * Public receipts go to out/receipts (safe to publish).
 * Private openings (values + salts) go to .sealed/openings (never publish).
 */
export class ReceiptStore {
  constructor(readonly outDir = "out", readonly sealedDir = ".sealed") {
    mkdirSync(join(outDir, "receipts"), { recursive: true });
    mkdirSync(join(sealedDir, "openings"), { recursive: true });
  }

  save(receipt: Receipt, openings: PrivateOpenings): string {
    const path = join(this.outDir, "receipts", `${receipt.receiptId}.json`);
    writeFileSync(path, JSON.stringify(receipt, null, 2));
    writeFileSync(join(this.sealedDir, "openings", `${receipt.receiptId}.json`), JSON.stringify(openings, null, 2), { mode: 0o600 });
    return path;
  }

  load(receiptId: string): Receipt | undefined {
    const path = join(this.outDir, "receipts", `${receiptId}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Receipt) : undefined;
  }

  /** Raw TEE request and response bytes. Private: they contain the secret policy. */
  saveTeeExchange(receiptId: string, exchange: { request: string; response: string }): string {
    mkdirSync(join(this.sealedDir, "tee"), { recursive: true });
    const path = join(this.sealedDir, "tee", `${receiptId}.json`);
    writeFileSync(path, JSON.stringify(exchange), { mode: 0o600 });
    return path;
  }

  saveExecution(receiptId: string, record: unknown): string {
    mkdirSync(join(this.outDir, "executions"), { recursive: true });
    const path = join(this.outDir, "executions", `${receiptId}.json`);
    writeFileSync(path, JSON.stringify(record, null, 2));
    return path;
  }
}
