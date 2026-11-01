import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** ed25519 key that signs receipts on behalf of this Sealed Intent instance. */
export interface IssuerKey {
  privateKey: KeyObject;
  publicKeyHex: string; // raw 32 bytes
}

export function publicKeyHex(pub: KeyObject): string {
  const der = pub.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

export function publicKeyFromHex(hex: string): KeyObject {
  // SPKI prefix for a raw ed25519 key
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
}

export function loadOrCreateIssuerKey(path: string): IssuerKey {
  if (existsSync(path)) {
    const privateKey = createPrivateKey(readFileSync(path, "utf8"));
    return { privateKey, publicKeyHex: publicKeyHex(createPublicKey(privateKey)) };
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return { privateKey, publicKeyHex: publicKeyHex(publicKey) };
}

export function signBytes(key: IssuerKey, data: string): string {
  return sign(null, Buffer.from(data), key.privateKey).toString("hex");
}

export function verifyBytes(publicKeyHexValue: string, data: string, signatureHex: string): boolean {
  try {
    return verify(null, Buffer.from(data), publicKeyFromHex(publicKeyHexValue), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
