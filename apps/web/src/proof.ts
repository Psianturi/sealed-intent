// The proof page: each claim is checked by this browser against NEAR, NEAR AI Cloud and NEAR Intents.
import { esc } from "./arena-data";
import { nonceTime, ONE_CLICK_MANAGER_KEY, reviewHashOf, verifyNep413, verifyQuote, type QuoteResponse, type SignedMessage } from "./proof-core";
import { explorerTx, formatAmount, rpc, view, type Agent } from "./verify-chain";
import { verifyReceipt, type Check } from "./verify-core";

interface Tx { label: string; hash: string; signer?: string; part?: string; verdict?: string; owner?: string }
interface Approval { decisionId: string; message: string; recipient: string; reviewHash: string; shownToOwner: Record<string, any>; signed: SignedMessage; execution: { txHash: string } }
interface Data {
  network: string; registry: string; wallet: string; owner: string; agent: string; codeHash?: string;
  setup: Tx[]; payments: Tx[]; refusedByCustody: number;
  bypass: { hash: string; detectedSeconds: number; frozenSeconds: number; freezeTx?: string };
  enclave?: { receiptId: string; model: string; signingAddress: string; tcbStatus?: string; gpus?: number; tlsBound?: boolean };
  approval?: Approval; quote?: QuoteResponse;
}
/** demo rows show a forgery on purpose and info rows only explain; neither changes the summary */
type Row = Check & { linkText?: string; demo?: boolean; info?: boolean };
type Part = "contract" | "custody" | "enclave" | "intents" | "approval" | "mainnet";

const $ = (id: string) => document.getElementById(id)!;
// named accounts stay whole; hex accounts, hashes and signatures are cut down
const short = (s: string) => (s.length > 44 || /^(0x)?[0-9a-f]{40,}$/i.test(s) ? `${s.slice(0, 10)}…${s.slice(-6)}` : s);
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const custodyContract = (network: string) => (network === "testnet" ? "outlayer.testnet" : "outlayer.near");
const explorerAccount = (network: string, id: string) => `https://${network === "testnet" ? "testnet." : ""}nearblocks.io/address/${id}`;

function render(part: Part, rows: Row[]) {
  $(`${part}-checks`).innerHTML = rows
    .map((c, i) => {
      const cls = c.ok === true ? "yes" : c.ok === false ? "no" : "maybe";
      const link = c.link ? ` <a href="${esc(c.link)}"${c.link.startsWith("http") ? ' target="_blank" rel="noopener"' : ""}>${esc(c.linkText ?? "See it on NearBlocks")}</a>` : "";
      return `<li class="${cls}${c.demo ? " demo" : ""}" style="--i:${i}"><span class="mono" aria-hidden="true">${c.ok === true ? "✓" : c.ok === false ? "✕" : "·"}</span><span>${esc(c.name)}${c.detail ? ` <span class="note">${esc(c.detail)}</span>` : ""}${link}</span></li>`;
    })
    .join("");
}

function settle(part: Part, rows: Row[], fact: string) {
  const real = rows.filter((r) => !r.demo && !r.info);
  const li = document.querySelector<HTMLElement>(`#board [data-part="${part}"]`)!;
  const state = real.some((r) => r.ok === false) ? "bad" : real.every((r) => r.ok === true) ? "ok" : "partial";
  li.dataset.state = state;
  li.querySelector(".board-state")!.textContent = state === "bad" ? "A check failed" : fact;
}

function countUp(el: HTMLElement, to: number) {
  if (calm || to < 2) return void (el.textContent = String(to));
  const start = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / 900);
    el.textContent = String(Math.round(to * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

interface TxView { transaction: { signer_id: string; receiver_id: string; actions: (string | Record<string, any>)[] }; status: { Failure?: unknown } }
const actionName = (a: string | Record<string, any>) => (typeof a === "string" ? a : a.FunctionCall ? a.FunctionCall.method_name : a.Transfer ? "transfer" : a.DeployContract ? "deploy" : Object.keys(a)[0]!);
const readTx = (network: string, hash: string, signer: string) => rpc<TxView>(network, "tx", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" }).catch(() => undefined);

async function callRow(d: Data, t: Tx, signer: string, expect: { receiver: string; method?: string }): Promise<Row> {
  const v = await readTx(d.network, t.hash, signer);
  const link = explorerTx(d.network, t.hash);
  if (!v) return { name: t.label, ok: false, detail: "not found on chain", link };
  const acts = v.transaction.actions.map(actionName);
  const ok = !v.status.Failure && v.transaction.signer_id === signer && v.transaction.receiver_id === expect.receiver && (!expect.method || acts.includes(expect.method));
  return { name: t.label, ok, detail: `${short(v.transaction.signer_id)} called ${acts.join(" + ")} on ${short(v.transaction.receiver_id)}${v.status.Failure ? ", and it failed" : ""}`, link };
}

/** A payment signed by the custody wallet, with who was paid and how much. */
async function paymentRow(d: Data, label: string, hash: string): Promise<Row> {
  const v = await readTx(d.network, hash, d.wallet);
  const link = explorerTx(d.network, hash);
  if (!v) return { name: label, ok: false, detail: "not found on chain", link };
  const a = v.transaction.actions[0]!;
  const ft = typeof a !== "string" && a.FunctionCall?.method_name === "ft_transfer" ? (JSON.parse(atob(a.FunctionCall.args)) as { receiver_id: string; amount: string }) : undefined;
  const to = ft?.receiver_id ?? v.transaction.receiver_id;
  const amount = ft?.amount ?? (typeof a !== "string" ? a.Transfer?.deposit : undefined);
  const ok = !v.status.Failure && v.transaction.signer_id === d.wallet;
  return { name: label, ok, detail: `signed by the custody wallet, paid ${amount ? formatAmount(amount, ft ? v.transaction.receiver_id : "native") : "?"} to ${short(to)}${v.status.Failure ? ", and it failed" : ""}`, link };
}

async function contract(d: Data) {
  const rows: Row[] = [];
  const acct = await rpc<{ code_hash: string }>(d.network, "query", { request_type: "view_account", finality: "final", account_id: d.registry }).catch(() => undefined);
  rows.push(acct ? { name: `The contract lives at ${d.registry}`, ok: acct.code_hash !== "11111111111111111111111111111111", detail: `code hash ${acct.code_hash}`, link: explorerAccount(d.network, d.registry) } : { name: `The contract lives at ${d.registry}`, ok: false, detail: "could not read the account" });
  if (acct && d.codeHash) rows.push({ name: "The code on chain is exactly the build in the repository", ok: acct.code_hash === d.codeHash, detail: acct.code_hash === d.codeHash ? "the sha256 of sein_registry.wasm matches the chain" : `the repository build is ${d.codeHash}`, });
  const [agents, keys, anchors] = await Promise.all([view<number>(d.network, d.registry, "agent_count", {}), view<string[]>(d.network, d.registry, "issuer_keys", {}), view<number>(d.network, d.registry, "anchor_count", {})].map((p) => p.catch(() => undefined)));
  const batches = await Promise.all(Array.from({ length: Number(anchors ?? 0) }, (_, i) => view<{ count: number }>(d.network, d.registry, "get_anchor", { index: i }).catch(() => undefined)));
  const anchored = batches.reduce((s, b) => s + (b?.count ?? 0), 0);
  const stats: [number, string][] = [[Number(agents ?? 0), Number(agents) === 1 ? "agent registered" : "agents registered"], [Array.isArray(keys) ? keys.length : 0, "receipt signing key"], [Number(anchors ?? 0), "batches on chain"], [anchored, "receipts anchored"]];
  $("contract-stats").innerHTML = stats.map(([n, l]) => `<div class="stat"><b class="mono">0</b><span>${esc(l)}</span></div>`).join("");
  $("contract-stats").querySelectorAll<HTMLElement>("b").forEach((b, i) => countUp(b, stats[i]![0]));
  const agent = await view<Agent>(d.network, d.registry, "get_agent", { agent_id: d.agent }).catch(() => undefined);
  rows.push(agent ? { name: `${d.agent} is registered to its owner and its custody wallet`, ok: agent.owner === d.owner && agent.custody_account === d.wallet, detail: `owner ${agent.owner}, status ${agent.status}`, link: `/a/${d.agent}`, linkText: "Agent profile" } : { name: `${d.agent} is registered`, ok: false, detail: "no such agent" });
  for (const t of d.setup.filter((x) => x.part === "contract")) rows.push(await callRow(d, t, t.signer!, { receiver: d.registry }));
  render("contract", rows);
  settle("contract", rows, `${anchored} receipts anchored`);
}

async function custody(d: Data) {
  const rows: Row[] = [];
  const acct = await rpc<{ amount: string }>(d.network, "query", { request_type: "view_account", finality: "final", account_id: d.wallet }).catch(() => undefined);
  const balance = acct ? `${(Number(BigInt(acct.amount) / 10n ** 21n) / 1000).toFixed(3)} test NEAR` : "";
  rows.push({ name: "The custody wallet exists on NEAR", ok: !!acct, detail: acct ? `${short(d.wallet)}, balance ${balance}` : "could not read the account", link: explorerAccount(d.network, d.wallet) });
  for (const t of d.setup.filter((x) => x.part === "custody")) rows.push(await callRow(d, t, t.signer!, { receiver: custodyContract(d.network), method: "store_wallet_policy" }));
  for (const p of d.payments) rows.push(await paymentRow(d, p.label, p.hash));
  if (d.refusedByCustody) rows.push({ name: `${d.refusedByCustody} payment the owner approved by mistake was refused by custody itself`, ok: "unchecked", info: true, detail: "nothing was signed, so there is no transaction to show; it is in the evidence file", link: "/evidence/custody-flow.json", linkText: "Evidence file" });
  rows.push({ ...(await paymentRow(d, "A payment sent around SeIn, straight to custody", d.bypass.hash)), linkText: "See it on NearBlocks" });
  if (d.bypass.freezeTx) rows.push(await callRow(d, { label: `SeIn noticed it after ${d.bypass.detectedSeconds} s and froze the wallet on chain after ${d.bypass.frozenSeconds} s`, hash: d.bypass.freezeTx }, d.owner, { receiver: custodyContract(d.network), method: "freeze_wallet" }));
  render("custody", rows);
  settle("custody", rows, `${d.payments.length + 1} payments on chain`);
}

async function enclave(d: Data) {
  const e = d.enclave;
  if (!e) return settle("enclave", [{ name: "", ok: "unchecked" }], "No receipt published");
  const rows: Row[] = [];
  const receipt = await fetch(`/receipts/${e.receiptId}.json`).then((r) => r.json()).catch(() => undefined);
  if (receipt) for (const c of verifyReceipt(receipt, "").checks.filter((c) => !c.name.startsWith("  ") && !/one you trust|Who the operator/.test(c.name))) rows.push({ ...c, ...(c.name.startsWith("Tied to hardware") ? { link: `/r/${e.receiptId}`, linkText: "Open the receipt" } : {}) });
  else rows.push({ name: "SeIn's receipt with the enclave's answer", ok: false, detail: "could not load it" });
  const url = `https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(e.model)}&signing_algo=ecdsa`;
  const report = await fetch(url).then((r) => r.json() as Promise<{ model_attestations?: { signing_address?: string }[] }>).catch(() => undefined);
  const listed = (report?.model_attestations ?? []).map((a) => String(a.signing_address).toLowerCase());
  if (!report) rows.push({ name: "NEAR AI publishes this enclave key today", ok: "unchecked", detail: "could not reach NEAR AI from this browser" });
  else if (listed.includes(e.signingAddress.toLowerCase())) rows.push({ name: "NEAR AI's public attestation lists the same enclave key today", ok: true, detail: `${e.signingAddress}, model ${e.model}`, link: url, linkText: "NEAR AI's report" });
  else rows.push({ name: "NEAR AI's public attestation lists the same enclave key today", ok: "unchecked", detail: `NEAR AI now lists ${listed.map(short).join(", ") || "no key"}. Keys change when an enclave restarts; the receipt keeps what was checked at the time.`, link: url, linkText: "NEAR AI's report" });
  render("enclave", rows);
  settle("enclave", rows, listed.includes(e.signingAddress.toLowerCase()) ? "Same key published today" : "Enclave signature valid");
}

const QUOTE_ASK = { dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: "nep141:wrap.near", depositType: "ORIGIN_CHAIN", destinationAsset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", amount: "1000000000000000000000000", refundTo: "root.near", refundType: "ORIGIN_CHAIN", recipient: "root.near", recipientType: "DESTINATION_CHAIN" };
let freshRow: Row | undefined;
let quoteDemo = false;
const oneDigit = (q: QuoteResponse): QuoteResponse => ({ ...q, quote: { ...q.quote, amountOut: String(BigInt(q.quote.amountOut) + 1n) } });
const quoteText = (q: QuoteResponse) => `${q.quote.amountInFormatted} wNEAR for ${q.quote.amountOutFormatted} USDC, signed ${q.timestamp.slice(0, 19).replace("T", " ")} UTC`;

function intents(d: Data) {
  const q = d.quote;
  if (!q) return settle("intents", [{ name: "", ok: "unchecked" }], "No quote recorded");
  const rows: Row[] = [
    { name: "A quote SeIn recorded carries a valid NEAR Intents signature", ok: verifyQuote(q), detail: quoteText(q) },
    { name: "Checked with the key from 1Click's official SDK", ok: true, detail: ONE_CLICK_MANAGER_KEY, link: "https://github.com/defuse-protocol/one-click-sdk-typescript", linkText: "The SDK" },
    { name: "The same quote with one digit changed is refused", ok: !verifyQuote(oneDigit(q)) },
  ];
  if (freshRow) rows.push(freshRow);
  if (quoteDemo) {
    const base = freshRow?.ok === true && lastFresh ? lastFresh : q;
    const forged = oneDigit(base);
    const usdc = (x: string) => formatAmount(x, base.quoteRequest.destinationAsset);
    rows.unshift({ name: "You changed one digit of the price: the signature no longer matches", ok: verifyQuote(forged), detail: `now says ${usdc(forged.quote.amountOut)} instead of ${usdc(base.quote.amountOut)}`, demo: true });
  }
  render("intents", rows);
  settle("intents", rows, freshRow?.ok === true ? "Fresh quote verified" : "Quote signature valid");
}

let lastFresh: QuoteResponse | undefined;
async function askFresh(d: Data) {
  const btn = $("fresh-quote") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Asking NEAR Intents…";
  try {
    const res = await fetch("https://1click.chaindefuser.com/v0/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...QUOTE_ASK, deadline: new Date(Date.now() + 600_000).toISOString() }) });
    if (!res.ok) throw new Error(`NEAR Intents answered ${res.status}`);
    lastFresh = (await res.json()) as QuoteResponse;
    freshRow = { name: "A fresh quote, asked just now by your browser, carries a valid signature", ok: verifyQuote(lastFresh), detail: quoteText(lastFresh) };
  } catch (e) {
    freshRow = { name: "A fresh quote, asked just now by your browser", ok: "unchecked", detail: `could not reach NEAR Intents (${(e as Error).message})` };
  }
  btn.disabled = false;
  btn.textContent = "Ask for another fresh quote";
  intents(d);
}

let approvalDemo = false;
async function approval(d: Data) {
  const a = d.approval;
  if (!a) return settle("approval", [{ name: "", ok: "unchecked" }], "No approval published");
  const shown = a.shownToOwner;
  $("approval-msg").textContent = `${a.message}\n\nsigned by  ${a.signed.accountId}\nfor        ${a.recipient}\nkey        ${a.signed.publicKey}`;
  const rows: Row[] = [];
  rows.push({ name: "The wallet signature is valid for this exact message (NEP-413)", ok: verifyNep413(a.signed, a.message, a.recipient), detail: `signature ${short(a.signed.signature)}` });
  const key = await rpc<{ permission: unknown }>(d.network, "query", { request_type: "view_access_key", finality: "final", account_id: a.signed.accountId, public_key: a.signed.publicKey }).catch(() => undefined);
  rows.push({ name: `The signing key is a full-access key of ${a.signed.accountId} on chain`, ok: key ? key.permission === "FullAccess" : false, detail: key ? (key.permission === "FullAccess" ? "read from the account's keys just now" : "the key is limited, so it cannot approve") : "the account has no such key now", link: explorerAccount(d.network, a.signed.accountId) });
  const hash = reviewHashOf(shown);
  rows.push({ name: "The message carries the fingerprint of exactly what the owner was shown", ok: hash === a.reviewHash && a.message.endsWith(hash), detail: `${formatAmount(String(shown.amount), String(shown.token))} to ${shown.recipient}, flagged ${(shown.warnCodes as string[]).join(", ")}` });
  const lag = Math.round((nonceTime(a.signed.nonce) - Date.parse(String(shown.createdAt))) / 1000);
  rows.push({ name: lag < 2 ? "Signed right after SeIn asked" : `Signed ${lag} seconds after SeIn asked`, ok: lag >= 0 && lag < 600, detail: "the time sits in the signed nonce, so an old signature cannot be replayed later. In this recording a script held the owner's key; on the approve page the owner signs in their own wallet." });
  rows.push({ name: "The same signature does not work for a rejection or another payment", ok: !verifyNep413(a.signed, a.message.replace(" approve ", " reject "), a.recipient) && !verifyNep413(a.signed, a.message.replace(a.decisionId, crypto.randomUUID()), a.recipient) });
  rows.push({ ...(await paymentRow(d, "Custody paid only after the signature was accepted", a.execution.txHash)) });
  rows.push({ name: "The full decision, its execution and their batch on chain", ok: true, detail: "SeIn's receipt for this approval, checked against the registry", link: `/r/${a.decisionId}`, linkText: "Open the receipt" });
  if (approvalDemo) {
    const other = reviewHashOf({ ...shown, amount: "10000000000000000000000000" });
    rows.unshift({ name: "Had the owner been shown 10 NEAR, the fingerprint would differ and this signature would not match", ok: verifyNep413(a.signed, `SeIn approve ${a.decisionId} ${other}`, a.recipient), detail: `fingerprint ${short(other)} instead of ${short(hash)}`, demo: true });
  }
  render("approval", rows);
  settle("approval", rows, "Signature valid on chain");
}

/** The one run on NEAR mainnet, read back from mainnet by this browser. */
const MAINNET = {"wallet":"019524dce6417ea37a76c81245268d7c43d86237b4dccfc94bec5f452f2ce1ff","controller":"1e7f14ff1d363689ce9f0fae2ee965a91e54074d3813d4d3b6b144a484083185","policyTx":"65PTyS53uu7J2qPEkg6siK3vzHcxzwHWQS9kKDwczGYq","fundTx":"5KiGr5gvUGyRnD5Yq4mEkCcBbCvLQgH7bh5VQE8kSHgo","payTx":"4GYCHxrbFFVPawDt5ugdeyWFjud2ehvpa17yegjZyPav","allow":"bf9f09a5-4e5d-417d-a72e-21be3f9e4b38","block":"b343df46-2b17-4b3d-ae3a-ce7479c07403"};
async function mainnet(d: Data) {
  const m = { ...d, network: "mainnet", wallet: MAINNET.wallet };
  const rows: Row[] = [
    await callRow(m, { label: "A controller account stored the custody policy, before any money arrived", hash: MAINNET.policyTx }, MAINNET.controller, { receiver: "outlayer.near", method: "store_wallet_policy" }),
    await callRow(m, { label: "Then it funded the custody wallet", hash: MAINNET.fundTx }, MAINNET.controller, { receiver: MAINNET.wallet, method: "transfer" }),
    { name: "A request with pressure, secrecy and an unknown receiver was refused", ok: "unchecked", info: true, detail: "BLOCK: nothing was signed, so there is no transaction; the signed receipt is the record", link: `/r/${MAINNET.block}`, linkText: "Open the receipt" },
    await paymentRow(m, "An ordinary invoice to a listed receiver was allowed and paid", MAINNET.payTx),
    { name: "Its receipt, signed by the operator, with the enclave's signed opinion", ok: "unchecked", info: true, detail: "not anchored: the registry lives on testnet", link: `/r/${MAINNET.allow}`, linkText: "Open the receipt" },
  ];
  render("mainnet", rows);
}

async function runAll(d: Data) {
  for (const li of document.querySelectorAll<HTMLElement>("#board li")) {
    li.dataset.state = "checking";
    li.querySelector(".board-state")!.textContent = "Checking…";
  }
  $("checked-at").textContent = "Your browser is checking…";
  await Promise.all([contract(d), custody(d), enclave(d), Promise.resolve(intents(d)), approval(d), mainnet(d)].map((p) => p.catch(() => undefined)));
  $("checked-at").textContent = `Checked by this browser at ${new Date().toLocaleTimeString()}. Every line links to where you can see it yourself.`;
}

async function main() {
  const d = (await (await fetch("/proof/data.json")).json()) as Data;
  $("rerun").addEventListener("click", () => void runAll(d));
  $("fresh-quote").addEventListener("click", () => void askFresh(d));
  $("tamper-quote").addEventListener("click", () => {
    quoteDemo = !quoteDemo;
    $("tamper-quote").textContent = quoteDemo ? "Put the digit back" : "Change one digit";
    intents(d);
  });
  $("tamper-approval").addEventListener("click", () => {
    approvalDemo = !approvalDemo;
    $("tamper-approval").textContent = approvalDemo ? "Show what the owner really saw" : "Show the owner 10 NEAR instead";
    void approval(d);
  });
  await runAll(d);
  void askFresh(d);
}
void main();
