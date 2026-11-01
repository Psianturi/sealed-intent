import { createHash } from "node:crypto";
import { once } from "node:events";
import { Agent, request } from "node:https";
import { connect, type ConnectionOptions } from "node:tls";

/**
 * One TLS connection whose peer key is known. NEAR AI Cloud binds the gateway certificate's key
 * into its attestation quote, and that binding only means something for the connection it was
 * read on, so the report and the prompt must travel over this same socket. If the server closes
 * it, later requests fail instead of quietly reconnecting.
 */
export interface BoundConnection {
  fetch: typeof fetch;
  /** SHA-256 of the DER SubjectPublicKeyInfo presented on this connection */
  peerSpkiSha256: string;
  close(): void;
}

export async function openBoundConnection(baseUrl: string, tlsOptions: ConnectionOptions = {}): Promise<BoundConnection> {
  const { hostname, port, origin } = new URL(baseUrl);
  const socket = connect({ host: hostname, port: Number(port || 443), servername: /^[\d.]+$/.test(hostname) ? undefined : hostname, ALPNProtocols: ["http/1.1"], ...tlsOptions });
  const timer = setTimeout(() => socket.destroy(new Error("TLS connect timed out")), 15_000);
  try {
    await once(socket, "secureConnect");
  } finally {
    clearTimeout(timer);
  }
  const cert = socket.getPeerX509Certificate();
  if (!cert) {
    socket.destroy();
    throw new Error("the server presented no certificate");
  }
  const peerSpkiSha256 = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");

  let handedOut = false;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  agent.createConnection = (() => {
    if (handedOut) throw new Error("the attested TLS connection is gone; the evidence no longer applies");
    handedOut = true;
    return socket;
  }) as typeof agent.createConnection;

  const boundFetch = ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== origin) return reject(new Error(`refusing to use the attested connection for ${url.origin}`));
      const req = request(url, { method: init?.method ?? "GET", headers: init?.headers as Record<string, string> | undefined, agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers }));
        });
      });
      req.on("socket", (s) => {
        if (s !== (socket as unknown)) req.destroy(new Error("request left the attested TLS connection"));
      });
      req.setTimeout(120_000, () => req.destroy(new Error("request timed out")));
      req.on("error", reject);
      if (init?.body) req.write(init.body as string);
      req.end();
    })) as typeof fetch;

  return {
    fetch: boundFetch,
    peerSpkiSha256,
    close() {
      agent.destroy();
      socket.destroy();
    },
  };
}
