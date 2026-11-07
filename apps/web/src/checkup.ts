// SeIn Checkpoint: scan any NEAR account from this browser, cut bad connections with the owner's wallet, keep the lesson.
import { esc } from "./arena-data";
import { lessonFrom, scan, type AccessKey, type Finding, type Flag, type Lesson, type Network, type ScanInput, type ScanResult } from "./checkup-core";
import type { Scene } from "./checkup-scene";
import { explorerTx } from "./verify-chain";

const RPC: Record<Network, string> = { mainnet: "https://free.rpc.fastnear.com", testnet: "https://test.rpc.fastnear.com" };
const FAST: Record<Network, string> = { mainnet: "https://api.fastnear.com", testnet: "https://test.api.fastnear.com" };
const BLOCKS: Record<Network, string> = { mainnet: "https://api.nearblocks.io", testnet: "https://api-testnet.nearblocks.io" };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, calm ? 0 : ms));

async function rpc<T>(network: Network, params: Record<string, unknown>): Promise<{ result?: T; error?: string }> {
  const res = await fetch(RPC[network], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "checkup", method: "query", params: { finality: "final", ...params } }) });
  const j = (await res.json()) as { result?: T & { error?: string }; error?: { cause?: { name?: string } } };
  if (j.error) return { error: j.error.cause?.name ?? "error" };
  if (j.result?.error) return { error: j.result.error };
  return { result: j.result };
}

const log = (line: string, state: "run" | "done" | "warn" = "run") => {
  const li = document.createElement("li");
  li.className = state;
  li.textContent = line;
  $("cp-log").append(li);
  return li;
};

async function gather(account: string, network: Network, flagged: Flag[]): Promise<ScanInput> {
  $("cp-log").innerHTML = "";
  const base: ScanInput = { network, account, exists: false, keys: [], missing: [], tokens: [], nfts: [], pools: [], contacts: [], flagged };
  let step = log(`Reading ${account} on NEAR ${network}`);
  const acct = await rpc<{ code_hash: string; amount: string }>(network, { request_type: "view_account", account_id: account });
  if (!acct.result) {
    step.className = "warn";
    return base;
  }
  step.className = "done";
  await sleep(250);
  step = log("Reading every key that can sign for it");
  const keys = await rpc<{ keys: AccessKey[] }>(network, { request_type: "view_access_key_list", account_id: account });
  step.className = "done";
  step.textContent = `${keys.result?.keys.length ?? 0} keys found`;
  await sleep(250);

  step = log("Checking the apps it is connected to");
  const receivers = [...new Set((keys.result?.keys ?? []).flatMap((k) => (k.access_key.permission === "FullAccess" ? [] : [k.access_key.permission.FunctionCall.receiver_id])))].slice(0, 30);
  const exists = await Promise.all(receivers.map((r) => rpc(network, { request_type: "view_account", account_id: r }).then((x) => !!x.result).catch(() => true)));
  step.className = "done";
  await sleep(250);

  step = log("Reading tokens, NFTs and staking");
  const full = await fetch(`${FAST[network]}/v1/account/${encodeURIComponent(account)}/full`).then((r) => r.json() as Promise<{ tokens?: { contract_id: string }[]; nfts?: { contract_id: string }[]; pools?: { pool_id: string }[] }>).catch(() => undefined);
  step.className = full ? "done" : "warn";
  await sleep(250);

  step = log("Checking who it recently dealt with");
  const txs = await fetch(`${BLOCKS[network]}/v3/accounts/${encodeURIComponent(account)}/txns?limit=25`).then((r) => (r.ok ? (r.json() as Promise<{ data?: { signer_account_id: string; receiver_account_id: string }[] }>) : undefined)).catch(() => undefined);
  const contacts = (txs?.data ?? []).flatMap((t) => [t.signer_account_id, t.receiver_account_id]).filter((c) => c && c !== account);
  step.className = txs ? "done" : "warn";
  if (!txs) step.textContent = "Recent contacts could not be read right now";

  return {
    ...base,
    exists: true,
    codeHash: acct.result.code_hash,
    balance: acct.result.amount,
    keys: keys.result?.keys ?? [],
    missing: receivers.filter((_, i) => !exists[i]),
    tokens: (full?.tokens ?? []).map((t) => t.contract_id),
    nfts: (full?.nfts ?? []).map((t) => t.contract_id),
    pools: (full?.pools ?? []).map((p) => p.pool_id),
    contacts,
  };
}

const ICON: Record<Finding["severity"], string> = { danger: "!", caution: "?", ok: "✓", info: "i" };
const ORDER: Finding["severity"][] = ["danger", "caution", "info", "ok"];

function renderFindings(r: ScanResult) {
  const sorted = [...r.findings].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  $("cp-findings").innerHTML = sorted
    .map((f, i) => `<li class="cp-f ${f.severity}" style="--i:${i}"><span class="cp-f-icon" aria-hidden="true">${ICON[f.severity]}</span><div><p class="cp-f-title">${esc(f.title)}</p><p class="cp-f-detail">${esc(f.detail)}</p></div></li>`)
    .join("");
}

function countUp(el: HTMLElement, to: number) {
  if (calm) return void (el.textContent = String(to));
  const from = Number(el.textContent) || 0;
  const start = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - start) / 1100);
    el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderScore(r: ScanResult) {
  const box = $("cp-score");
  box.dataset.grade = r.grade === "Healthy" ? "ok" : r.grade === "Needs care" ? "caution" : "danger";
  countUp($("cp-score-n"), r.score);
  $("cp-grade").textContent = r.grade;
  const d = r.findings.filter((f) => f.severity === "danger").length;
  const c = r.findings.filter((f) => f.severity === "caution").length;
  $("cp-score-sub").textContent = `${d} urgent, ${c} to check, ${r.connections.filter((x) => x.kind === "key").length} app connections`;
}

function renderLesson(l: Lesson) {
  $("cp-lesson-list").innerHTML = l.rules.map((r) => `<li>${esc(r)}</li>`).join("");
  const json = JSON.stringify(l, null, 2);
  $("cp-lesson-copy").onclick = () => void navigator.clipboard?.writeText(json).then(() => ($("cp-lesson-copy").textContent = "Copied"));
  const a = $<HTMLAnchorElement>("cp-lesson-download");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = `sein-lesson-${l.account}.json`;
}

let current: { account: string; network: Network; input: ScanInput; result: ScanResult } | undefined;
let scene: Scene | undefined;
let flagged: Flag[] = [];

function renderHeal(r: ScanResult) {
  const heal = r.findings.filter((f) => f.heal && f.key);
  $("cp-heal").hidden = heal.length === 0;
  $("cp-heal-list").innerHTML = heal.map((f) => `<li><label><input type="checkbox" value="${esc(f.key!)}" data-id="key:${esc(f.key!)}" checked /> <span>${esc(f.target ?? "")}</span> <span class="cp-tag ${f.severity}">${f.severity === "danger" ? "urgent" : "check"}</span></label></li>`).join("");
  $("cp-heal-status").textContent = "";
}

async function run(account: string, network: Network) {
  account = account.trim().toLowerCase();
  if (!account) return;
  history.replaceState(null, "", `?account=${encodeURIComponent(account)}&network=${network}`);
  document.body.dataset.state = "scanning";
  $("cp-result").hidden = true;
  scene?.scanning(true);
  const input = await gather(account, network, flagged);
  const result = scan(input);
  current = { account, network, input, result };
  await sleep(300);
  scene?.scanning(false);
  scene?.show(result.connections, result.score);
  renderScore(result);
  renderFindings(result);
  renderHeal(result);
  renderLesson(lessonFrom(input, result));
  log(`Done: ${result.grade.toLowerCase()}, ${result.score} of 100`, "done");
  document.body.dataset.state = "done";
  $("cp-result").hidden = false;
}

async function heal(preview: boolean) {
  if (!current) return;
  const boxes = [...document.querySelectorAll<HTMLInputElement>("#cp-heal-list input:checked")];
  if (!boxes.length) return void ($("cp-heal-status").textContent = "Pick at least one connection.");
  const ids = boxes.map((b) => b.dataset.id!);
  const cut = boxes.map((b) => b.value);
  const after = scan({ ...current.input, keys: current.input.keys.filter((k) => !cut.includes(k.public_key)) }).score;
  if (preview) {
    $("cp-heal-status").textContent = "Preview only: nothing was signed, the account is unchanged.";
    await scene?.heal(ids, after);
    countUp($("cp-score-n"), after);
    $("cp-grade").textContent = `${after >= 85 ? "Healthy" : after >= 60 ? "Needs care" : "At risk"} after healing (preview)`;
    return;
  }
  const status = $("cp-heal-status");
  status.textContent = "Opening your wallet…";
  try {
    const { NearConnector } = await import("@hot-labs/near-connect");
    const net = current.network;
    const connector = new NearConnector({ network: net, features: { signAndSendTransaction: true, ...(net === "testnet" ? { testnet: true } : {}) } });
    const w = await connector.connect();
    const accounts = await w.getAccounts();
    if (!accounts.some((a) => a.accountId === current!.account)) throw new Error(`Connect ${current.account} itself. This wallet holds ${accounts.map((a) => a.accountId).join(", ") || "no account"}.`);
    status.textContent = `Sign one transaction that deletes ${boxes.length} connection key${boxes.length === 1 ? "" : "s"}. Your full-access keys are not touched.`;
    const out = (await w.signAndSendTransaction({ signerId: current.account, receiverId: current.account, actions: boxes.map((b) => ({ type: "DeleteKey" as const, params: { publicKey: b.value } })) })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
    const hash = out.transaction?.hash ?? out.transaction_outcome?.id;
    status.innerHTML = `Done. ${hash ? `<a href="${esc(explorerTx(net, hash))}" target="_blank" rel="noopener">See the transaction</a>.` : ""} Checking again…`;
    await scene?.heal(ids, after);
    await run(current.account, current.network);
  } catch (err) {
    status.textContent = (err as Error).message || "The wallet did not sign.";
  }
}

async function main() {
  flagged = await fetch("/checkup/flagged.json").then((r) => r.json() as Promise<{ accounts: Flag[] }>).then((j) => j.accounts).catch(() => []);
  const canvas = $<HTMLCanvasElement>("cp-canvas");
  const { createScene } = await import("./checkup-scene");
  scene = createScene(canvas);
  if (!scene) document.body.classList.add("no-webgl");
  const form = $<HTMLFormElement>("cp-form");
  const input = $<HTMLInputElement>("cp-account");
  const net = $<HTMLSelectElement>("cp-network");
  input.addEventListener("input", () => {
    if (input.value.trim().endsWith(".testnet")) net.value = "testnet";
    else if (/\.(near|tg)$/.test(input.value.trim())) net.value = "mainnet";
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void run(input.value, net.value as Network);
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-example]")) {
    b.addEventListener("click", () => {
      input.value = b.dataset.example!;
      net.value = b.dataset.network!;
      void run(input.value, net.value as Network);
    });
  }
  $("cp-heal-go").addEventListener("click", () => void heal(false));
  $("cp-heal-preview").addEventListener("click", () => void heal(true));
  const q = new URLSearchParams(location.search);
  const account = q.get("account");
  if (account) {
    input.value = account;
    net.value = q.get("network") === "testnet" ? "testnet" : "mainnet";
    void run(account, net.value as Network);
  }
  (window as unknown as { __seinCheckup: unknown }).__seinCheckup = { run, get current() { return current; } };
}
void main();
