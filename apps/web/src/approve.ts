import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { esc } from "./arena-data";
import { reason } from "./copy";
import { formatAmount } from "./verify-chain";
import { canonical } from "./verify-core";

interface Review { decisionId: string; createdAt: string; agentId: string; kind: string; token?: string; amount?: string; recipient?: string; usd: number; warnCodes: string[]; route?: string; routeNote?: { hidden: string[]; stillPublic: string[]; extraCostBps?: number }; approvedBy?: string }
interface Answer { review: Review; owner?: string; network: string; signRequired: boolean }
interface Signed { accountId: string; publicKey: string; signature: string }
interface Signer { signMessage(p: { message: string; recipient: string; nonce: Uint8Array; network: string; signerId?: string }): Promise<Signed> }

const RECIPIENT = "sein-approval";
const FREEZE_MESSAGE = "SeIn freeze all payments";
const $ = (id: string) => document.getElementById(id)!;
const decisionId = location.pathname.match(/\/approve\/([0-9a-f-]{36})/)?.[1] ?? new URLSearchParams(location.search).get("id") ?? "";
const params = new URLSearchParams(location.hash.slice(1));
const gateway = params.get("g") ?? "";
const key = params.get("k") ?? "";

/** The signed text names the decision and a hash of exactly what is shown here; the server rebuilds both. */
const reviewHash = (r: Review) => {
  const { approvedBy: _a, ...shown } = r;
  return bytesToHex(sha256(utf8ToBytes(canonical(shown))));
};

/** NEP-413 nonce: the first 8 bytes carry the time, so an old signature cannot be replayed later. */
function nonce(): Uint8Array {
  const n = crypto.getRandomValues(new Uint8Array(32));
  new DataView(n.buffer).setBigUint64(0, BigInt(Date.now()));
  return n;
}

const fail = (title: string, text: string) => ($("ask").innerHTML = `<article class="result bad"><p class="result-head"><span class="result-icon" aria-hidden="true">✕</span>${esc(title)}</p><p>${esc(text)}</p></article>`);

let signer: Signer | undefined;
async function wallet(network: string, owner?: string): Promise<Signer> {
  // a stand-in signer for automated checks, accepted only on this machine
  const injected = (window as unknown as { __seinSigner?: Signer }).__seinSigner;
  if (injected && location.hostname === "localhost") return injected;
  if (signer) return signer;
  const { NearConnector } = await import("@hot-labs/near-connect");
  const connector = new NearConnector({ network: network === "testnet" ? "testnet" : "mainnet", features: { signMessage: true, ...(network === "testnet" ? { testnet: true } : {}) } });
  const w = await connector.connect();
  const accounts = await w.getAccounts();
  if (owner && !accounts.some((a) => a.accountId === owner)) throw new Error(`Connect the owner's account ${owner}. This wallet holds ${accounts.map((a) => a.accountId).join(", ") || "no account"}.`);
  signer = { signMessage: (p) => w.signMessage({ ...p, network: p.network as "mainnet" | "testnet" }) };
  return signer;
}

async function post(path: string, data: unknown): Promise<Record<string, any>> {
  const res = await fetch(`${gateway}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  return { http: res.status, ...((await res.json().catch(() => ({}))) as Record<string, any>) };
}

async function answer(a: Answer, action: "approve" | "reject") {
  const status = $("status");
  status.textContent = "Waiting for your wallet…";
  try {
    const n = nonce();
    const w = await wallet(a.network, a.owner);
    const s = await w.signMessage({ message: `SeIn ${action} ${decisionId} ${reviewHash(a.review)}`, recipient: RECIPIENT, nonce: n, network: a.network, signerId: a.owner });
    status.textContent = "Checking your signature on NEAR…";
    const r = await post(`/v1/${action}`, { decisionId, signed: { action, decisionId, accountId: s.accountId, publicKey: s.publicKey, signature: s.signature, nonce: btoa(String.fromCharCode(...n)) } });
    if (r.http !== 200 || r.ok === false) throw new Error(r.error ?? r.details ?? "SeIn did not accept the answer");
    $("ask").innerHTML = `<article class="result ok"><p class="result-head"><span class="result-icon" aria-hidden="true">✓</span>${action === "approve" ? "Approved" : "Rejected"}</p><p>${action === "approve" ? "The agent may send this payment now. Custody still applies its own policy, and SeIn writes a receipt." : "Nothing will be sent, and the money it held back is free again."}</p></article>`;
  } catch (err) {
    status.textContent = (err as Error).message;
    status.classList.add("bad-text");
  }
}

async function freeze(a: Answer) {
  const status = $("status");
  status.textContent = "Waiting for your wallet…";
  try {
    const n = nonce();
    const w = await wallet(a.network, a.owner);
    const s = await w.signMessage({ message: FREEZE_MESSAGE, recipient: RECIPIENT, nonce: n, network: a.network, signerId: a.owner });
    const r = await post("/v1/freeze", { signed: { action: "freeze", accountId: s.accountId, publicKey: s.publicKey, signature: s.signature, nonce: btoa(String.fromCharCode(...n)) } });
    if (r.http !== 200 || !r.frozen) throw new Error(r.error ?? "SeIn did not stop");
    $("ask").innerHTML = `<article class="result bad"><p class="result-head"><span class="result-icon" aria-hidden="true">■</span>All payments stopped</p><p>Every agent is refused until you lift the freeze from your SeIn.${typeof r.custodyFreeze === "string" && r.custodyFreeze !== "not configured" ? " The custody wallet is frozen on chain too." : ""}</p></article>`;
  } catch (err) {
    status.textContent = (err as Error).message;
    status.classList.add("bad-text");
  }
}

function show(a: Answer) {
  const r = a.review;
  const amount = r.amount ? formatAmount(r.amount, r.token) : r.kind;
  const usd = r.usd ? `about $${r.usd.toFixed(2)}` : "";
  const note = r.routeNote;
  const route = note
    ? `<div><dt>Private route</dt><dd>Hides ${esc(note.hidden.join(" and "))}. Still public: ${esc(note.stillPublic.join(", "))}.${note.extraCostBps !== undefined ? ` Costs ${(note.extraCostBps / 100).toFixed(2)}% more.` : " The extra cost is not known."}</dd></div>`
    : "";
  $("ask").innerHTML = `
    <article class="result">
      <p class="ask-amount"><b>${esc(amount)}</b> <span class="note">${esc(usd)}</span></p>
      <dl class="sealed-list">
        <div><dt>To</dt><dd class="mono breaks">${esc(r.recipient ?? "")}</dd></div>
        <div><dt>Asked by</dt><dd>${esc(r.agentId)}</dd></div>
        <div><dt>Asked at</dt><dd>${esc(r.createdAt.slice(0, 16).replace("T", " "))} UTC</dd></div>
        ${route}
      </dl>
      <h3>Why you are asked</h3>
      <ul class="why">${r.warnCodes.map((c) => `<li>${esc(reason(c))}</li>`).join("")}</ul>
      ${a.owner ? `<p class="note">Sign as <span class="mono">${esc(a.owner)}</span> on ${esc(a.network)}.</p>` : `<p class="note">This SeIn does not ask for a wallet signature. Answer with the owner tool instead.</p>`}
      <div class="btns">
        <button class="btn primary big" id="approve"${a.signRequired ? "" : " disabled"}>Approve with my wallet</button>
        <button class="btn big" id="reject"${a.signRequired ? "" : " disabled"}>Reject</button>
      </div>
      <p class="note" id="status" role="status"></p>
      <p><button class="btn danger" id="freeze"${a.signRequired ? "" : " disabled"}>Stop all payments</button></p>
    </article>`;
  $("approve").addEventListener("click", () => void answer(a, "approve"));
  $("reject").addEventListener("click", () => void answer(a, "reject"));
  $("freeze").addEventListener("click", () => void freeze(a));
}

async function main() {
  if (!decisionId || !gateway || !key) return fail("This link is incomplete", "Open this page from the link your SeIn gave you. It carries the address of your SeIn and a one-time key.");
  let res: Response;
  try {
    res = await fetch(`${gateway}/v1/review/${decisionId}`, { headers: { Authorization: `Review ${key}` } });
  } catch {
    return fail("Your SeIn did not answer", `Is it running at ${gateway}, and did your browser allow this page to reach it?`);
  }
  const body = (await res.json().catch(() => ({}))) as Answer & { error?: string };
  if (!res.ok) return fail(res.status === 404 ? "Nothing to answer" : "This link does not work", body.error ?? `HTTP ${res.status}`);
  show(body);
}
void main();
