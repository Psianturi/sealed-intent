import { createHash } from "node:crypto";
import { getCollateralAndVerify } from "@phala/dcap-qvl";

/**
 * Verification of a NEAR AI Cloud attestation report, following
 * docs.near.ai/cloud/verification/reference/quote-nonce-signer. The verified Intel quote is the
 * source of truth; the JSON fields are only compared against it.
 */
export interface NearReport {
  intel_quote: string;
  signing_address: string;
  signing_algo: "ecdsa" | "ed25519";
  request_nonce?: string;
  tls_cert_fingerprint?: string;
  event_log?: string | unknown[];
  info?: { tcb_info?: string | { app_compose?: string } };
  nvidia_payload?: string;
}

export interface VerifiedQuote {
  status: string;
  advisoryIds: string[];
  report: { type: string; data: { tdAttributes: Uint8Array; reportData: Uint8Array; mrConfigId: Uint8Array; rtMr3: Uint8Array; mrTd: Uint8Array } };
}

export type QuoteVerifier = (quoteHex: string) => Promise<VerifiedQuote>;

/** Real verifier: Intel DCAP chain via dcap-qvl. Collateral comes from Phala's PCCS unless SEALED_PCCS_URL says otherwise. */
export const dcapVerifier: QuoteVerifier = async (quoteHex) => {
  const v = (await getCollateralAndVerify(hexBytes(quoteHex), process.env.SEALED_PCCS_URL)) as unknown as {
    status: string;
    advisory_ids?: string[];
    advisoryIds?: string[];
    report: VerifiedQuote["report"];
  };
  return { status: v.status, advisoryIds: v.advisory_ids ?? v.advisoryIds ?? [], report: v.report };
};

export interface ReportCheck {
  ok: boolean;
  signer: string;
  signingAlgo: string;
  tcbStatus?: string;
  advisoryIds: string[];
  measurements?: { mrTd: string; rtMr3: string; mrConfigId: string };
  checks: { name: string; ok: boolean }[];
  problems: string[];
}

export interface GpuCheck {
  present: boolean;
  ok: boolean;
  gpus?: number;
  arch?: string;
  problems: string[];
}

const hexBytes = (v: string) => Buffer.from(v.replace(/^0x/i, ""), "hex");
const parse = <T>(v: string | T): T => (typeof v === "string" ? (JSON.parse(v) as T) : v);
const hash = (alg: string, ...parts: (Buffer | string)[]) => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return h.digest();
};

export function replayRtmr3(eventLog: string | unknown[]): Buffer {
  let rtmr3 = Buffer.alloc(48);
  type Ev = { imr: number; event_type: number; event: string; event_payload?: string; digest?: string };
  for (const e of parse<Ev[]>(eventLog as string | Ev[])) {
    if (e.imr !== 3) continue;
    const t = Buffer.alloc(4);
    t.writeUInt32LE(e.event_type);
    const digest = hash("sha384", t, ":", Buffer.from(e.event, "utf8"), ":", hexBytes(e.event_payload ?? ""));
    if (e.digest && !hexBytes(e.digest).equals(digest)) throw new Error(`event log digest mismatch for ${e.event}`);
    rtmr3 = hash("sha384", rtmr3, digest);
  }
  return rtmr3;
}

export async function checkNearReport(
  report: NearReport,
  nonceHex: string,
  opts: { acceptedTcbStatuses: string[]; verifyQuote?: QuoteVerifier; peerSpkiSha256?: string },
): Promise<ReportCheck> {
  const checks: { name: string; ok: boolean }[] = [];
  const problems: string[] = [];
  const add = (name: string, ok: boolean, why?: string) => {
    checks.push({ name, ok });
    if (!ok) problems.push(why ?? name);
  };
  const out: ReportCheck = { ok: false, signer: report.signing_address, signingAlgo: report.signing_algo, advisoryIds: [], checks, problems };

  let verified: VerifiedQuote;
  try {
    if (!report.intel_quote) throw new Error("report has no intel_quote");
    verified = await (opts.verifyQuote ?? dcapVerifier)(report.intel_quote);
  } catch (err) {
    add("Intel TDX quote verified against Intel collateral", false, `quote verification failed: ${(err as Error).message}`);
    return out;
  }
  add("Intel TDX quote verified against Intel collateral", true);
  out.tcbStatus = verified.status;
  out.advisoryIds = verified.advisoryIds;
  add("TCB status accepted by policy", opts.acceptedTcbStatuses.includes(verified.status), `TCB status ${verified.status} not accepted (${verified.advisoryIds.join(", ") || "no advisories"})`);
  if (verified.report.type !== "td10") {
    add("quote is a TDX report", false, `expected td10, got ${verified.report.type}`);
    return out;
  }
  const q = verified.report.data;
  out.measurements = { mrTd: Buffer.from(q.mrTd).toString("hex"), rtMr3: Buffer.from(q.rtMr3).toString("hex"), mrConfigId: Buffer.from(q.mrConfigId).toString("hex") };
  add("TDX debug mode off", !(q.tdAttributes[0]! & 1));

  const identity = hexBytes(report.signing_address);
  const expectedLen = report.signing_algo === "ecdsa" ? 20 : 32;
  add("signing identity has the right length", identity.length === expectedLen);
  const fp = report.tls_cert_fingerprint;
  if (opts.peerSpkiSha256 !== undefined) add("TLS fingerprint matches the peer certificate", (fp ?? "").toLowerCase() === opts.peerSpkiSha256.toLowerCase());
  const bound = fp ? hash("sha256", identity, hexBytes(fp)) : Buffer.concat([identity, Buffer.alloc(Math.max(0, 32 - identity.length))]);
  add("report data binds the signer and our nonce", Buffer.from(q.reportData).equals(Buffer.concat([bound, hexBytes(nonceHex)])));
  add("echoed nonce matches", (report.request_nonce ?? "").toLowerCase() === nonceHex.toLowerCase());

  try {
    const tcb = parse<{ app_compose?: string }>(report.info?.tcb_info ?? "{}");
    const compose = tcb.app_compose ?? "";
    const expected = Buffer.concat([Buffer.from([1]), hash("sha256", Buffer.from(compose, "utf8")), Buffer.alloc(15)]);
    add("MRCONFIGID matches the measured app_compose", compose.length > 0 && Buffer.from(q.mrConfigId).equals(expected));
  } catch {
    add("MRCONFIGID matches the measured app_compose", false);
  }
  try {
    add("event log replays to RTMR3", replayRtmr3(report.event_log ?? "[]").equals(Buffer.from(q.rtMr3)));
  } catch (err) {
    add("event log replays to RTMR3", false, (err as Error).message);
  }
  out.ok = problems.length === 0;
  return out;
}

export async function checkGpuEvidence(report: NearReport, nonceHex: string, fetchImpl: typeof fetch = fetch): Promise<GpuCheck> {
  if (!report.nvidia_payload) return { present: false, ok: false, problems: ["no GPU evidence in report"] };
  const problems: string[] = [];
  let payload: { nonce?: string; arch?: string };
  try {
    payload = parse<{ nonce?: string; arch?: string }>(report.nvidia_payload);
  } catch {
    return { present: true, ok: false, problems: ["GPU evidence is not JSON"] };
  }
  if (String(payload.nonce ?? "").toLowerCase() !== nonceHex.toLowerCase()) return { present: true, ok: false, arch: payload.arch, problems: ["GPU evidence nonce does not match"] };
  const res = await fetchImpl("https://nras.attestation.nvidia.com/v3/attest/gpu", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return { present: true, ok: false, arch: payload.arch, problems: [`NRAS HTTP ${res.status}`] };
  const arr = (await res.json()) as [string, string][];
  const jwt = arr?.[0]?.[1];
  if (!jwt) return { present: true, ok: false, arch: payload.arch, problems: ["NRAS returned no token"] };
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  if (claims["x-nvidia-overall-att-result"] !== true) problems.push("NVIDIA overall attestation result is not true");
  if (String(claims.eat_nonce ?? "").toLowerCase() !== nonceHex.toLowerCase()) problems.push("NVIDIA token nonce does not match");
  const gpus = Object.keys((claims.submods as object) ?? {}).length || undefined;
  return { present: true, ok: problems.length === 0, gpus, arch: payload.arch, problems };
}
