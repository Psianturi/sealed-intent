import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

const enc = new TextEncoder();

/** keccak256("\x19Ethereum Signed Message:\n" + len(message) + message) */
export function eip191Hash(message: string): Uint8Array {
  const body = enc.encode(message);
  const prefix = enc.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const buf = new Uint8Array(prefix.length + body.length);
  buf.set(prefix, 0);
  buf.set(body, prefix.length);
  return keccak_256(buf);
}

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

export function addressFromPublicKey(uncompressed: Uint8Array): string {
  // drop the 0x04 prefix, keccak the 64-byte key, keep the last 20 bytes
  const hash = keccak_256(uncompressed.slice(1));
  return `0x${Buffer.from(hash.slice(-20)).toString("hex")}`;
}

/** Recover the Ethereum-style address that produced an EIP-191 signature. */
export function recoverEip191Address(message: string, signatureHex: string): string {
  const sig = strip0x(signatureHex);
  if (sig.length !== 130) throw new Error("signature must be 65 bytes (r||s||v)");
  const rs = sig.slice(0, 128);
  let v = parseInt(sig.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error(`invalid recovery id ${v}`);
  const pub = secp256k1.Signature.fromCompact(rs)
    .addRecoveryBit(v)
    .recoverPublicKey(eip191Hash(message))
    .toRawBytes(false);
  return addressFromPublicKey(pub);
}

/** Test helper: sign like an Ethereum wallet / NEAR AI Cloud ecdsa signer. */
export function signEip191(message: string, privateKeyHex: string): { signature: string; address: string } {
  const priv = strip0x(privateKeyHex);
  const sig = secp256k1.sign(eip191Hash(message), priv);
  const signature = `0x${sig.toCompactHex()}${(27 + sig.recovery).toString(16)}`;
  const address = addressFromPublicKey(secp256k1.getPublicKey(priv, false));
  return { signature, address };
}
