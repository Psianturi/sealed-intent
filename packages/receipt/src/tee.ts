import { ed25519 } from "@noble/curves/ed25519";
import { recoverEip191Address } from "./eip191";

/**
 * Evidence that a private check ran inside a TEE (NEAR AI Cloud).
 *
 * NEAR AI Cloud signs `<model>:<sha256(request bytes)>:<sha256(response bytes)>`
 * (signature_kind = provider_tee) or `<request_hash>:<response_hash>` (gateway).
 * See docs.near.ai/cloud/verification/cloud-api/response-signatures.
 *
 * Only hashes go into the public receipt. The raw request (which contains the
 * secret policy and the agent's intent) never leaves the operator.
 */
export interface TeeEvidence {
  kind: "nearai-cloud" | "offline-simulated";
  signatureKind: "provider_tee" | "gateway";
  model?: string;
  chatId?: string;
  text: string;
  signature: string;
  signingAddress: string;
  signingAlgo: "ecdsa" | "ed25519";
  requestHash: string;
  responseHash: string;
  attestation: {
    nonce: string;
    /** signing_address of the response matched the attested report fetched BEFORE the completion */
    signingAddressMatched: boolean;
    /** Intel TDX / NVIDIA quote verified locally (dcap-qvl). Not done in this MVP; see README. */
    quoteVerifiedLocally: boolean;
    /** Human-readable list of what WAS checked (the "Verified" panel). */
    checks?: { name: string; ok: boolean }[];
    note?: string;
  };
  /** What the model concluded. A signal only: the deterministic engine decides. */
  signal: "allow" | "warn" | "block";
  signalCodes: string[];
}

export interface TeeCheckResult {
  textMatchesHashes: boolean;
  signatureValid: boolean;
  attestationBound: boolean;
  simulated: boolean;
  problems: string[];
}

export function expectedSignedText(e: Pick<TeeEvidence, "signatureKind" | "model" | "requestHash" | "responseHash">): string {
  return e.signatureKind === "provider_tee"
    ? `${e.model}:${e.requestHash}:${e.responseHash}`
    : `${e.requestHash}:${e.responseHash}`;
}

export function verifyTeeEvidence(e: TeeEvidence): TeeCheckResult {
  const problems: string[] = [];
  const textMatchesHashes = e.text === expectedSignedText(e);
  if (!textMatchesHashes) problems.push("signed text does not match request/response hashes");

  let signatureValid = false;
  try {
    if (e.signingAlgo === "ecdsa") {
      signatureValid = recoverEip191Address(e.text, e.signature).toLowerCase() === e.signingAddress.toLowerCase();
    } else if (e.signingAlgo === "ed25519") {
      signatureValid = ed25519.verify(
        Buffer.from(e.signature.replace(/^0x/, ""), "hex"),
        new TextEncoder().encode(e.text),
        Buffer.from(e.signingAddress.replace(/^0x/, ""), "hex"),
      );
    } else {
      problems.push(`unsupported signing algorithm ${String(e.signingAlgo)}`);
    }
  } catch (err) {
    problems.push(`signature check failed: ${(err as Error).message}`);
  }
  if (!signatureValid) problems.push("signature does not match signing address");
  if (!e.attestation.signingAddressMatched) problems.push("signing address not bound to an attestation report");
  if (e.kind === "offline-simulated") problems.push("simulated enclave (offline demo), not a real TEE");

  return {
    textMatchesHashes,
    signatureValid,
    attestationBound: e.attestation.signingAddressMatched,
    simulated: e.kind === "offline-simulated",
    problems,
  };
}
