// Attestation checks against a real NEAR AI Cloud report captured on 1 Nov 2026.
// Intel signature verification needs network collateral, so these tests replace that
// one step with a parse-only verifier and exercise everything else for real.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Quote } from "@phala/dcap-qvl";
import { describe, expect, it } from "vitest";
import { checkGpuEvidence, checkNearReport, dcapVerifier, replayRtmr3, type NearReport, type QuoteVerifier } from "../src/attestation";
import { DEMO_POLICY } from "../src/fixtures";
import { NearAiCloudChecker, signerMatches } from "../src/tee-check";

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "attestation.json"), "utf8")) as {
  nonce: string;
  body: { gateway_attestation: NearReport; model_attestations: NearReport[] };
};
const gateway = fixture.body.gateway_attestation;
const model = fixture.body.model_attestations[0]!;
const parseOnly: QuoteVerifier = async (hex) => ({ status: "UpToDate", advisoryIds: [], report: Quote.parse(Buffer.from(hex, "hex")).report as never });
const opts = { acceptedTcbStatuses: ["UpToDate"], verifyQuote: parseOnly };
const live = process.env.SEALED_LIVE_TESTS === "1";

describe("NEAR report checks", () => {
  it("accepts the recorded gateway and model reports", async () => {
    for (const r of [gateway, model]) {
      const c = await checkNearReport(r, fixture.nonce, opts);
      expect(c.problems).toEqual([]);
      expect(c.ok).toBe(true);
      expect(c.measurements?.rtMr3).toHaveLength(96);
    }
  });

  it("rejects a replayed report with another nonce", async () => {
    const c = await checkNearReport({ ...gateway, request_nonce: "ab".repeat(32) }, "ab".repeat(32), opts);
    expect(c.ok).toBe(false);
    expect(c.problems).toContain("report data binds the signer and our nonce");
  });

  it("rejects a forged signer, a missing quote and a tampered event log", async () => {
    expect((await checkNearReport({ ...model, signing_address: "0x" + "11".repeat(20) }, fixture.nonce, opts)).ok).toBe(false);
    const noQuote = await checkNearReport({ ...model, intel_quote: "" }, fixture.nonce, opts);
    expect(noQuote.problems[0]).toContain("quote verification failed");
    const log = (typeof model.event_log === "string" ? JSON.parse(model.event_log) : model.event_log) as { imr: number; event: string }[];
    const tampered = log.map((e) => (e.imr === 3 ? { ...e, event: e.event + "x" } : e));
    expect((await checkNearReport({ ...model, event_log: JSON.stringify(tampered) }, fixture.nonce, opts)).problems.join()).toMatch(/RTMR3|digest/);
  });

  it("rejects a TCB status the policy does not accept", async () => {
    const stale: QuoteVerifier = async (hex) => ({ ...(await parseOnly(hex)), status: "OutOfDate", advisoryIds: ["INTEL-SA-00001"] });
    const c = await checkNearReport(gateway, fixture.nonce, { acceptedTcbStatuses: ["UpToDate"], verifyQuote: stale });
    expect(c.problems[0]).toContain("OutOfDate");
  });

  it("replays RTMR3 deterministically", () => {
    expect(replayRtmr3(model.event_log!)).toEqual(replayRtmr3(model.event_log!));
  });

  it("checks GPU evidence nonce before calling NVIDIA", async () => {
    let called = false;
    const fetchMock = (async () => {
      called = true;
      return new Response("[]");
    }) as unknown as typeof fetch;
    const wrong = await checkGpuEvidence(model, "cd".repeat(32), fetchMock);
    expect(wrong.ok).toBe(false);
    expect(called).toBe(false);
    expect((await checkGpuEvidence(gateway, fixture.nonce, fetchMock)).present).toBe(false);
  });
});

describe("NearAiCloudChecker refuses before sending the policy", () => {
  const intent = { kind: "transfer" as const, token: "nep141:wrap.near", amount: "1", recipient: "a.near", purpose: "general" };
  const policy = { ...DEMO_POLICY, tee: { ...DEMO_POLICY.tee, requireGpu: false } };

  function server(report: unknown, onCompletion: () => void) {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/attestation/report")) return new Response(JSON.stringify(report));
      if (url.includes("/chat/completions")) onCompletion();
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
  }

  it("a server without a verifiable quote never receives the prompt", async () => {
    let promptSent = false;
    const fake = { gateway_attestation: { ...gateway, intel_quote: "" }, model_attestations: [model] };
    const checker = new NearAiCloudChecker({ apiKey: "k", model: "m", baseUrl: "https://evil.example/v1", fetch: server(fake, () => (promptSent = true)), verifyQuote: parseOnly });
    await expect(checker.check({ intent, policy, injectionCodes: [] })).rejects.toThrow(/gateway attestation rejected/);
    expect(promptSent).toBe(false);
  });

  it("a relayed report with a stale nonce is rejected too", async () => {
    let promptSent = false;
    const checker = new NearAiCloudChecker({ apiKey: "k", model: "m", baseUrl: "https://evil.example/v1", fetch: server(fixture.body, () => (promptSent = true)), verifyQuote: parseOnly });
    await expect(checker.check({ intent, policy, injectionCodes: [] })).rejects.toThrow(/nonce/);
    expect(promptSent).toBe(false);
  });
});

describe.skipIf(!live)("live: real Intel and NVIDIA verification", () => {
  it("verifies the recorded reports with real collateral", async () => {
    const c = await checkNearReport(model, fixture.nonce, { acceptedTcbStatuses: ["UpToDate"], verifyQuote: dcapVerifier });
    expect(c.ok).toBe(true);
    expect((await checkGpuEvidence(model, fixture.nonce)).ok).toBe(true);
  }, 60_000);
});

describe("matching the answer's signer to the verified reports", () => {
  const key = "0x3b753b4406613c5e70ae640508632b600424fa0c";
  it("accepts the shared key of several enclaves, in any letter case, and nothing else", () => {
    const reports = [1, 2, 3].map(() => ({ signing_address: key, signing_algo: "ecdsa" }));
    expect(reports.filter((r) => signerMatches(r, key.toUpperCase().replace("0X", "0x"), "ecdsa"))).toHaveLength(3);
    expect(reports.filter((r) => signerMatches(r, "0x" + "1".repeat(40), "ecdsa"))).toHaveLength(0);
    expect(signerMatches({ signing_address: key, signing_algo: "ed25519" }, key, "ecdsa")).toBe(false);
  });
});
