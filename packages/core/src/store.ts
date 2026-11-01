import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadVault, type PrivateOpenings, type Receipt, type Vault } from "@sealed-intent/receipt";

const PRIVATE_DIRS = ["openings", "tee", "audit"];

/**
 * Public receipts go to out/receipts (safe to publish).
 * Openings, raw enclave exchanges and audit records go to .sealed, encrypted, and expire.
 */
export class ReceiptStore {
  private cached?: Vault;

  constructor(readonly outDir = "out", readonly sealedDir = ".sealed", vault?: Vault) {
    this.cached = vault;
    mkdirSync(join(outDir, "receipts"), { recursive: true });
    mkdirSync(sealedDir, { recursive: true, mode: 0o700 });
  }

  private get vault(): Vault {
    return (this.cached ??= loadVault(this.sealedDir));
  }

  private writeSealed(dir: string, name: string, value: unknown): string {
    mkdirSync(join(this.sealedDir, dir), { recursive: true, mode: 0o700 });
    const path = join(this.sealedDir, dir, `${name}.sealed`);
    writeFileSync(path, this.vault.seal(value), { mode: 0o600 });
    return path;
  }

  save(receipt: Receipt, openings: PrivateOpenings): string {
    this.writeSealed("openings", receipt.receiptId, openings);
    return this.savePublic(receipt.receiptId, receipt);
  }

  savePublic(receiptId: string, record: unknown): string {
    const path = join(this.outDir, "receipts", `${receiptId}.json`);
    writeFileSync(path, JSON.stringify(record, null, 2));
    return path;
  }

  load(receiptId: string): Receipt | undefined {
    const path = join(this.outDir, "receipts", `${receiptId}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Receipt) : undefined;
  }

  loadOpenings(receiptId: string): PrivateOpenings | undefined {
    const path = join(this.sealedDir, "openings", `${receiptId}.sealed`);
    return existsSync(path) ? this.vault.open<PrivateOpenings>(readFileSync(path, "utf8")) : undefined;
  }

  /** Raw TEE request and response bytes. They contain the secret policy, so an auditor gets them only from the owner. */
  saveTeeExchange(receiptId: string, exchange: { request: string; response: string }): string {
    return this.writeSealed("tee", receiptId, exchange);
  }

  loadTeeExchange(receiptId: string): { request: string; response: string } | undefined {
    const path = join(this.sealedDir, "tee", `${receiptId}.sealed`);
    return existsSync(path) ? this.vault.open(readFileSync(path, "utf8")) : undefined;
  }

  /** Who approved, froze or accepted what, and execution details. Encrypted, for the owner. */
  saveAudit(name: string, record: unknown): string {
    return this.writeSealed("audit", name, record);
  }

  /** Deletes private records older than the retention window. Their receipts stay valid; the fields can no longer be opened. */
  purge(retentionDays: number, now = Date.now()): number {
    const cutoff = now - retentionDays * 86_400_000;
    let removed = 0;
    for (const dir of PRIVATE_DIRS) {
      const full = join(this.sealedDir, dir);
      if (!existsSync(full)) continue;
      for (const name of readdirSync(full)) {
        const file = join(full, name);
        if (statSync(file).mtimeMs < cutoff) {
          rmSync(file);
          removed++;
        }
      }
    }
    return removed;
  }
}
