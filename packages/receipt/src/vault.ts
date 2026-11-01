import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Private data at rest. Values are sealed with AES-256-GCM. Lookups that must not reveal
 * an account or agent name use a keyed hash, so the database never holds the name itself.
 */
export class Vault {
  private readonly enc: Buffer;
  private readonly mac: Buffer;

  constructor(master: Buffer) {
    if (master.length !== 32) throw new Error("the data key must be 32 bytes");
    this.enc = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "sealed-intent/vault/enc", 32));
    this.mac = Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "sealed-intent/vault/mac", 32));
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.enc, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
  }

  open<T>(sealed: string): T {
    const [version, iv, tag, ct] = sealed.trim().split(".");
    if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("not a sealed value");
    const decipher = createDecipheriv("aes-256-gcm", this.enc, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8")) as T;
  }

  /** Same input, same output, unreadable without the key. */
  blind(value: string): string {
    return createHmac("sha256", this.mac).update(value).digest("hex");
  }
}

/**
 * The data key comes from SEALED_DATA_KEY or SEALED_POLICY_KEY (32-byte hex). Offline, a key
 * file is generated next to the data, which protects copies of the data but not a stolen disk.
 * Live mode refuses that fallback.
 */
export function loadVault(home: string, opts: { requireEnvKey?: boolean; env?: NodeJS.ProcessEnv } = {}): Vault {
  const env = opts.env ?? process.env;
  const hex = env.SEALED_DATA_KEY || env.SEALED_POLICY_KEY;
  if (hex) {
    const key = Buffer.from(hex.trim(), "hex");
    if (key.length !== 32) throw new Error("SEALED_DATA_KEY or SEALED_POLICY_KEY must be 32 bytes of hex");
    return new Vault(key);
  }
  if (opts.requireEnvKey) throw new Error("live mode needs SEALED_DATA_KEY or SEALED_POLICY_KEY to encrypt private data at rest");
  const path = join(home, "data.key");
  if (existsSync(path)) return new Vault(Buffer.from(readFileSync(path, "utf8").trim(), "hex"));
  const key = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, key.toString("hex"), { mode: 0o600 });
  return new Vault(key);
}

/** Reads KEY=value lines without overriding the real environment. Values are never printed. */
export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[m[1]!] === undefined && value !== "") process.env[m[1]!] = value;
  }
}
