// Browser port of packages/receipt verification. Same canonical JSON, same checks, no server.
import { ed25519 } from "@noble/curves/ed25519";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = sortDeep(v);
  }
  return out;
}
const canonical = (v: unknown) => JSON.stringify(sortDeep(v));
const sha256Hex = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

function recoverEip191(text: string, signatureHex: string): string {
  const msg = utf8ToBytes(text);
  const prefixed = new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]);
  const digest = keccak_256(prefixed);
  const sig = hexToBytes(signatureHex.replace(/^0x/, ""));
  let v = sig[64]!;
  if (v >= 27) v -= 27;
  const s = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v);
  const pub = s.recoverPublicKey(digest).toRawBytes(false);
  return "0x" + bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}

export interface Check { name: string; ok: boolean | "unchecked"; detail?: string }

export function verifyReceipt(r: Record<string, any>, trusted: string, disclosure?: Record<string, any>): { valid: boolean; checks: Check[] } {
  const checks: Check[] = [];
  const { signature, ...unsigned } = r;
  let sigOk = false;
  try {
    sigOk = ed25519.verify(hexToBytes(signature), utf8ToBytes(canonical(unsigned)), hexToBytes(r.issuer.publicKey));
  } catch {}
  checks.push({ name: "Signed by the operator's key and not edited since", ok: sigOk });
  if (trusted) checks.push({ name: "The operator's key is the one you trust", ok: trusted.toLowerCase() === String(r.issuer.publicKey).toLowerCase() });
  else checks.push({ name: "Who the operator is", ok: "unchecked", detail: "not confirmed: paste the operator's published key under Advanced" });

  let teeOk = true;
  if (r.tee) {
    const e = r.tee;
    const expected = e.signatureKind === "provider_tee" ? `${e.model}:${e.requestHash}:${e.responseHash}` : `${e.requestHash}:${e.responseHash}`;
    const textOk = e.text === expected;
    let sOk = false;
    try {
      sOk = e.signingAlgo === "ecdsa" ? recoverEip191(e.text, e.signature).toLowerCase() === String(e.signingAddress).toLowerCase() : ed25519.verify(hexToBytes(String(e.signature).replace(/^0x/, "")), utf8ToBytes(e.text), hexToBytes(String(e.signingAddress).replace(/^0x/, "")));
    } catch {}
    const simulated = e.kind === "offline-simulated";
    const bound = Boolean(e.attestation?.signingAddressMatched && e.attestation?.quoteVerifiedLocally);
    checks.push({ name: "The enclave signed exactly this question and answer", ok: textOk });
    checks.push({ name: "The enclave's signature is valid", ok: sOk, detail: String(e.signingAddress) });
    if (simulated) checks.push({ name: "Real enclave", ok: "unchecked", detail: "no: a local stand-in, labelled as simulated" });
    else {
      checks.push({ name: "Tied to hardware evidence checked at decision time (Intel TDX, NVIDIA)", ok: bound, detail: e.attestation?.tcbStatus ? `Intel status ${e.attestation.tcbStatus}, ${e.attestation.gpus ?? "?"} GPUs` : undefined });
      for (const c of e.attestation?.checks ?? []) checks.push({ name: `  ${c.name}`, ok: c.ok });
    }
    teeOk = textOk && sOk && (simulated || bound);
  }

  let discOk = true;
  if (disclosure) {
    const commitment = disclosure.field === "policy" ? r.policyCommitment : r.commitments?.[disclosure.field];
    const ok = disclosure.receiptId === r.receiptId && commitment === sha256Hex(`${disclosure.opening.salt}:${canonical(disclosure.opening.value)}`);
    checks.push({ name: `Opened field "${disclosure.field}" matches its seal`, ok, detail: ok ? JSON.stringify(disclosure.opening.value) : undefined });
    discOk = ok;
  }
  return { valid: sigOk && teeOk && discOk && (!trusted || checks[1]!.ok === true), checks };
}

export function verifyExecution(r: Record<string, any>, trusted: string): { valid: boolean; checks: Check[] } {
  const { signature, ...unsigned } = r;
  let ok = false;
  try {
    ok = ed25519.verify(hexToBytes(signature), utf8ToBytes(canonical(unsigned)), hexToBytes(r.issuer.publicKey));
  } catch {}
  const checks: Check[] = [{ name: "Signed by the operator's key and not edited since", ok }, { name: `Execution of decision ${r.decisionId}: ${r.status}${r.txHash ? `, tx ${r.txHash}` : ""}`, ok: "unchecked" }];
  if (trusted) checks.push({ name: "The operator's key is the one you trust", ok: trusted.toLowerCase() === String(r.issuer.publicKey).toLowerCase() });
  return { valid: ok && (!trusted || checks[2]!.ok === true), checks };
}

