// S2: the report and the prompt share one TLS connection, and the gateway quote must bind its key.
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Quote } from "@phala/dcap-qvl";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuoteVerifier } from "../src/attestation";
import { buildPreflight } from "../src/config";
import { ASSET, DEMO_ACCOUNTS, DEMO_POLICY } from "../src/fixtures";
import { NearAiCloudChecker, TeeUnverifiedError } from "../src/tee-check";
import { openBoundConnection, type BoundConnection } from "../src/tee-tls";

const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "attestation.json"), "utf8")) as { nonce: string; body: { gateway_attestation: { tls_cert_fingerprint: string } } };
const parseOnly: QuoteVerifier = async (hex) => ({ status: "UpToDate", advisoryIds: [], report: Quote.parse(Buffer.from(hex, "hex")).report as never });
const policy = { ...DEMO_POLICY, tee: { ...DEMO_POLICY.tee, required: true, requireGpu: false } };
const intent = { kind: "transfer", token: ASSET.USDC, amount: "5000000", recipient: DEMO_ACCOUNTS.payroll, purpose: "payroll", taskText: "Routine treasury task approved by ops." };

/** A gateway that replays a genuine report over a connection with the given certificate key. */
function relay(peerSpkiSha256: string, onPrompt: () => void): BoundConnection {
  return {
    peerSpkiSha256,
    close() {},
    fetch: (async (url: string | URL) => {
      if (String(url).includes("/attestation/report")) return new Response(JSON.stringify(fixture.body));
      onPrompt();
      return new Response("{}", { status: 500 });
    }) as typeof fetch,
  };
}
const checker = (conn: BoundConnection) => new NearAiCloudChecker({ apiKey: "k", model: "m", baseUrl: "https://cloud-api.near.ai/v1", connect: async () => conn, verifyQuote: parseOnly, randomNonce: () => fixture.nonce, fetch: (async () => new Response("[]", { status: 503 })) as typeof fetch });

describe("gateway TLS binding", () => {
  it("a genuine report relayed over another certificate never receives the prompt", async () => {
    let promptSent = false;
    const c = checker(relay("00".repeat(32), () => (promptSent = true)));
    const err = await c.check({ intent: intent as never, policy, injectionCodes: [] }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(TeeUnverifiedError);
    expect((err as Error).message).toContain("TLS fingerprint matches the peer certificate");
    expect(promptSent).toBe(false);
  });

  it("the prompt is sent only when the connection's key is the one the quote binds", async () => {
    let promptSent = false;
    const c = checker(relay(fixture.body.gateway_attestation.tls_cert_fingerprint, () => (promptSent = true)));
    await c.check({ intent: intent as never, policy, injectionCodes: [] }).catch(() => undefined);
    expect(promptSent).toBe(true);
  });

  it("a report without the fingerprint counts as unverified", async () => {
    const { tls_cert_fingerprint: _f, ...gateway } = fixture.body.gateway_attestation;
    const conn: BoundConnection = { peerSpkiSha256: "ab".repeat(32), close() {}, fetch: (async () => new Response(JSON.stringify({ ...fixture.body, gateway_attestation: gateway }))) as typeof fetch };
    await expect(checker(conn).check({ intent: intent as never, policy, injectionCodes: [] })).rejects.toBeInstanceOf(TeeUnverifiedError);
  });

  it("preflight reports TEE_UNVERIFIED and refuses, with the policy that requires the enclave", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-tls-"));
    const env = buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: ":memory:", policy, tee: checker(relay("00".repeat(32), () => undefined)) });
    const d = await env.preflight.evaluate({ agentId: "a", intent });
    expect(d.verdict).toBe("BLOCK");
    expect(d.reasonCodes).toContain("TEE_UNVERIFIED");
  });

  it("with an optional enclave, a failed check asks a human instead of passing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sealed-tls-"));
    const env = buildPreflight({ offline: true, home: join(dir, ".sealed"), outDir: join(dir, "out"), ledgerPath: ":memory:", policy: { ...policy, tee: { ...policy.tee, required: false } }, tee: checker(relay("00".repeat(32), () => undefined)) });
    const d = await env.preflight.evaluate({ agentId: "a", intent });
    expect(d.verdict).toBe("WARN");
    expect(d.warnCodes).toContain("TEE_UNVERIFIED");
  });
});

/** openssl makes a throwaway certificate at test time, so no key is ever committed. */
function makeCert(): { key: string; cert: string } | undefined {
  try {
    const dir = mkdtempSync(join(tmpdir(), "sealed-cert-"));
    const keyPath = join(dir, "k.pem");
    const certPath = join(dir, "c.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } catch {
    return undefined;
  }
}
const pair = makeCert();

describe.skipIf(!pair)("the connection itself", () => {
  let base = "";
  let spki = "";
  const sockets = new Set<unknown>();
  const server = createServer({ key: pair?.key, cert: pair?.cert }, (req, res) => {
    sockets.add(req.socket);
    if (req.url === "/v1/hangup") {
      res.end("bye");
      req.socket.destroy();
      return;
    }
    res.end(JSON.stringify({ url: req.url }));
  });
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `https://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    spki = createHash("sha256").update(new X509Certificate(pair!.cert).publicKey.export({ type: "spki", format: "der" })).digest("hex");
  });
  afterAll(() => server.close());
  const open = () => openBoundConnection(base, { rejectUnauthorized: false });

  it("reports the real certificate key and keeps every request on one socket", async () => {
    const conn = await open();
    expect(conn.peerSpkiSha256).toBe(spki);
    sockets.clear();
    for (const p of ["a", "b", "c"]) expect(((await (await conn.fetch(`${base}/${p}`)).json()) as { url: string }).url).toBe(`/v1/${p}`);
    expect(sockets.size).toBe(1);
    conn.close();
  });

  it("a closed connection fails instead of quietly reconnecting", async () => {
    const conn = await open();
    await (await conn.fetch(`${base}/hangup`)).text();
    await new Promise((r) => setTimeout(r, 50));
    await expect(conn.fetch(`${base}/after`)).rejects.toThrow();
    conn.close();
  });

  it("refuses to carry requests to another host", async () => {
    const conn = await open();
    await expect(conn.fetch("https://example.com/x")).rejects.toThrow(/attested connection/);
    conn.close();
  });

  it("an untrusted certificate is rejected by default", async () => {
    await expect(openBoundConnection(base)).rejects.toThrow();
  });
});
