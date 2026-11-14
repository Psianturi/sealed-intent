// SeIn Checkpoint: scan any NEAR account from this browser, cut bad connections with the owner's wallet, keep the lesson.
import { esc } from "./arena-data";
import { lessonFrom, safeToCut, scan, type AccessKey, type Finding, type Flag, type Lesson, type Network, type ScanInput, type ScanResult } from "./checkup-core";
import { outlook, type Outlook, type Tx } from "./checkup-outlook";
import type { Scene } from "./checkup-scene";
import { explorerTx } from "./verify-chain";

const RPC: Record<Network, string> = { mainnet: "https://free.rpc.fastnear.com", testnet: "https://test.rpc.fastnear.com" };
const FAST: Record<Network, string> = { mainnet: "https://api.fastnear.com", testnet: "https://test.api.fastnear.com" };
const BLOCKS: Record<Network, string> = { mainnet: "https://api.nearblocks.io", testnet: "https://api-testnet.nearblocks.io" };
const OUTLAYER: Record<Network, string> = { mainnet: "outlayer.near", testnet: "outlayer.testnet" };
const REGISTRY: Partial<Record<Network, string>> = { testnet: "sein-registry-mvy2i59w.testnet" };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, calm ? 0 : ms));

async function rpc<T>(network: Network, params: Record<string, unknown>): Promise<{ result?: T; error?: string }> {
  const res = await fetch(RPC[network], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "checkup", method: "query", params: { finality: "final", ...params } }), signal: AbortSignal.timeout(12_000) });
  const j = (await res.json()) as { result?: T & { error?: string }; error?: { cause?: { name?: string } } };
  if (j.error) return { error: j.error.cause?.name ?? "error" };
  if (j.result?.error) return { error: j.result.error };
  return { result: j.result };
}

async function view<T>(network: Network, contract: string, method: string, args: Record<string, unknown>): Promise<T | undefined> {
  const r = await rpc<{ result: number[] }>(network, { request_type: "call_function", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) }).catch(() => ({ result: undefined }));
  return r.result ? (JSON.parse(new TextDecoder().decode(new Uint8Array(r.result.result))) as T) : undefined;
}

/** Only what the chain proves: an OutLayer custody policy, or a SeIn registry entry. Anything else is "no sign of an agent", never "a person". */
async function identify(account: string, network: Network): Promise<{ agent: boolean; notes: string[] }> {
  const notes: string[] = [];
  if (/^[0-9a-f]{64}$/.test(account)) {
    const p = await view<{ owner: string; frozen?: boolean } | null>(network, OUTLAYER[network], "get_wallet_policy", { wallet_pubkey: `ed25519:${account}` });
    if (p) notes.push(`An AI agent's custody wallet on OutLayer, controlled by ${p.owner}${p.frozen ? ", frozen right now" : ""}`);
  }
  const registry = REGISTRY[network];
  if (registry) {
    const n = Math.min(Number((await view<number>(network, registry, "agent_count", {})) ?? 0), 20);
    const agents = await Promise.all(Array.from({ length: n }, (_, i) => view<{ agent_id: string; owner: string; custody_account: string }>(network, registry, "get_agent", { agent_id: `agent-${i + 1}` })));
    for (const a of agents) if (a?.custody_account === account) notes.push(`Registered as ${a.agent_id} in SeIn's registry, owned by ${a.owner}`);
  }
  return { agent: notes.length > 0, notes };
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
  identity = { agent: false, notes: [] };
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
  // a data source that hangs must not hold up the whole check-up
  const full = await fetch(`${FAST[network]}/v1/account/${encodeURIComponent(account)}/full`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? (r.json() as Promise<{ tokens?: { contract_id: string }[]; nfts?: { contract_id: string }[]; pools?: { pool_id: string }[] }>) : undefined)).catch(() => undefined);
  step.className = full ? "done" : "warn";
  if (!full) step.textContent = "Tokens and NFTs could not be read right now; the rest of the check goes on";
  await sleep(250);

  // NEAR Intents exists on mainnet only, and keeps its own key list per account
  let intentsKeys: string[] | undefined;
  if (network === "mainnet") {
    step = log("Reading the keys registered inside NEAR Intents");
    intentsKeys = await view<string[]>(network, "intents.near", "public_keys_of", { account_id: account });
    step.className = intentsKeys ? "done" : "warn";
    if (intentsKeys) step.textContent = `${intentsKeys.length} keys inside NEAR Intents`;
    await sleep(250);
  }

  step = log("Looking for signs of an AI agent");
  const who = await identify(account, network).catch(() => ({ agent: false, notes: [] as string[] }));
  identity = who;
  step.className = "done";
  step.textContent = who.agent ? "An AI agent's wallet" : "No sign of an AI agent";

  step = log("Checking who it recently dealt with");
  const txs = await fetch(`${BLOCKS[network]}/v3/accounts/${encodeURIComponent(account)}/txns?limit=50`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? (r.json() as Promise<{ data?: RawTx[] }>) : undefined)).catch(() => undefined);
  past = (txs?.data ?? []).map((t) => ({ signer: t.signer_account_id, receiver: t.receiver_account_id, actions: t.actions ?? [], deposit: t.actions_agg?.deposit ?? "0", time: Number(BigInt(t.block_timestamp ?? "0") / 1_000_000n), ok: t.outcomes?.status !== false }));
  const contacts = (txs?.data ?? []).flatMap((t) => [t.signer_account_id, t.receiver_account_id]).filter((c) => c && c !== account);
  step.className = txs ? "done" : "warn";
  if (!txs) step.textContent = "Recent history could not be read right now, so the outlook below has less to go on";

  return {
    ...base,
    exists: true,
    codeHash: acct.result.code_hash,
    balance: acct.result.amount,
    keys: keys.result?.keys ?? [],
    intentsKeys,
    missing: receivers.filter((_, i) => !exists[i]),
    tokens: (full?.tokens ?? []).map((t) => t.contract_id),
    nfts: (full?.nfts ?? []).map((t) => t.contract_id),
    pools: (full?.pools ?? []).map((p) => p.pool_id),
    contacts,
  };
}

interface RawTx { signer_account_id: string; receiver_account_id: string; actions?: { action: string; method?: string | null }[]; actions_agg?: { deposit?: string }; block_timestamp?: string; outcomes?: { status?: boolean } }
let past: Tx[] = [];

const LEVEL = { low: "Low", elevated: "Elevated", high: "High" } as const;
function renderOutlook(o: Outlook) {
  $("cp-outlook-head").textContent = o.headline;
  $("cp-outlook-basis").textContent = o.basis;
  $("cp-outlook-lanes").innerHTML = o.lanes
    .map((l) => `<article class="cp-lane ${l.level}"><p class="cp-lane-level"><span class="cp-meter" aria-hidden="true"><i></i><i></i><i></i></span>${LEVEL[l.level]}</p><h3>${esc(l.title)}</h3><ul>${l.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul><p class="cp-lane-do">${esc(l.action)}</p></article>`)
    .join("");
  $("cp-outlook").hidden = false;
  // the forecast is the answer people came for: say it next to the score, and bring the detail into view
  const link = $("cp-forecast");
  link.textContent = `Forecast: ${o.headline.replace(/\.$/, "").replace(/^Most exposed to: /, "most exposed to ")} ↓`;
  link.hidden = false;
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setTimeout(() => $("cp-outlook").scrollIntoView({ behavior: "smooth", block: "start" }), 1400);
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
  const who = $("cp-who");
  who.className = `cp-who ${identity.agent ? "agent" : "person"}`;
  who.textContent = identity.agent ? identity.notes.join(". ") : "No sign of an AI agent: no custody policy, no registry entry. Probably a person's wallet.";
  $("cp-lesson-how").textContent = identity.agent ? "This is an AI agent's wallet. Give the lesson to the SeIn that guards it: the accounts are blocked at once, and the agent can read the rules before it pays." : "For a person: keep these in mind. For an agent: give the lesson to the SeIn that guards it, and the accounts are blocked at once.";
}

function renderLesson(l: Lesson) {
  $("cp-lesson-list").innerHTML = l.rules.map((r) => `<li>${esc(r)}</li>`).join("");
  const json = JSON.stringify(l, null, 2);
  $("cp-lesson-copy").onclick = () => void navigator.clipboard?.writeText(json).then(() => ($("cp-lesson-copy").textContent = "Copied"));
  const a = $<HTMLAnchorElement>("cp-lesson-download");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = `sein-lesson-${l.account}.json`;
}

let identity: { agent: boolean; notes: string[] } = { agent: false, notes: [] };
let current: { account: string; network: Network; input: ScanInput; result: ScanResult } | undefined;
let scene: Scene | undefined;
let flagged: Flag[] = [];

function renderHeal(r: ScanResult) {
  const heal = r.findings.filter((f) => f.heal && f.key);
  $("cp-heal").hidden = heal.length === 0;
  $("cp-heal-list").innerHTML = heal.map((f) => `<li><label><input type="checkbox" value="${esc(f.key!)}" data-id="key:${esc(f.key!)}"${f.severity === "danger" ? " checked" : ""} /> <span>${esc(f.target ?? "")}</span> <span class="cp-tag ${f.severity}">${f.severity === "danger" ? "urgent" : "check"}</span></label></li>`).join("");
  $("cp-heal-status").textContent = "";
  $("cp-confirm").hidden = true;
  healCount();
}

/** The button says what it will do, and waits until there is something to do. */
function healCount() {
  const n = document.querySelectorAll("#cp-heal-list input:checked").length;
  const go = $<HTMLButtonElement>("cp-heal-go");
  go.disabled = n === 0;
  go.textContent = n ? `Cut ${n} connection${n === 1 ? "" : "s"} with my wallet` : "Tick a connection to cut";
  $("cp-confirm").hidden = true;
}

async function run(account: string, network: Network) {
  account = account.trim().toLowerCase();
  if (!account) return;
  history.replaceState(null, "", `?account=${encodeURIComponent(account)}&network=${network}`);
  document.body.dataset.state = "scanning";
  $("cp-result").hidden = true;
  $("cp-outlook").hidden = true;
  $("cp-forecast").hidden = true;
  scene?.scanning(true);
  const input = await gather(account, network, flagged);
  const result = scan(input);
  current = { account, network, input, result };
  await sleep(300);
  scene?.scanning(false);
  scene?.show(result.connections, result.score);
  renderScore(result);
  renderOutlook(outlook(input, result, past, identity));
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
  if (!boxes.length) return void ($("cp-heal-status").textContent = "Tick at least one connection in the list above.");
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
  // first a plain statement of what will happen; the wallet opens only after the owner confirms it
  const confirm = $("cp-confirm");
  if (confirm.hidden) {
    const apps = boxes.map((b) => b.closest("label")?.querySelector("span")?.textContent ?? "");
    confirm.innerHTML = `<p><b>You are about to sign one transaction</b> from ${esc(current.account)} to itself. It deletes ${boxes.length === 1 ? "this login key" : `these ${boxes.length} login keys`}:</p>
      <ul>${apps.map((a) => `<li class="mono">${esc(a)}</li>`).join("")}</ul>
      <p>What happens: ${boxes.length === 1 ? "that app forgets" : "those apps forget"} your login; you can log in again any time. No NEAR, token or NFT moves. Your full-access keys are not touched. The network fee is a fraction of a cent.</p>
      <div class="cp-actions"><button type="button" class="cp-go" id="cp-confirm-go">Confirm and open my wallet</button><button type="button" class="cp-ghost" id="cp-confirm-cancel">Cancel</button></div>`;
    confirm.hidden = false;
    status.textContent = "";
    confirm.scrollIntoView({ behavior: "smooth", block: "nearest" });
    $("cp-confirm-go").focus({ preventScroll: true });
    $("cp-confirm-go").onclick = () => void heal(false);
    $("cp-confirm-cancel").onclick = () => {
      confirm.hidden = true;
      status.textContent = "";
    };
    return;
  }
  confirm.hidden = true;
  status.textContent = "Reading the account's keys again…";
  try {
    const net = current.network;
    // the page could be stale or tampered with: decide from the chain, right now
    const fresh = await rpc<{ keys: AccessKey[] }>(net, { request_type: "view_access_key_list", account_id: current.account });
    const check = safeToCut(cut, fresh.result?.keys ?? []);
    if (!check.ok) throw new Error(check.reason);
    status.textContent = "Opening your wallet…";
    const { NearConnector } = await import("@hot-labs/near-connect");
    // no addFunctionCallKey: connecting adds nothing to the account
    const connector = new NearConnector({ network: net, features: { signAndSendTransaction: true, ...(net === "testnet" ? { testnet: true } : {}) } });
    const w = await connector.connect();
    const accounts = await w.getAccounts();
    if (!accounts.some((a) => a.accountId === current!.account)) throw new Error(`Connect ${current.account} itself, on ${net}. This wallet holds ${accounts.map((a) => a.accountId).join(", ") || "no account"}.`);
    status.textContent = `Check the transaction in your wallet: ${check.keys.length} DeleteKey action${check.keys.length === 1 ? "" : "s"}, from ${current.account} to ${current.account}, nothing else.`;
    const out = (await w.signAndSendTransaction({ network: net, signerId: current.account, receiverId: current.account, actions: check.keys.map((publicKey) => ({ type: "DeleteKey" as const, params: { publicKey } })) })) as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
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
  $("cp-heal-list").addEventListener("change", healCount);
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
