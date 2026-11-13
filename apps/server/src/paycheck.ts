// The public check of one real payment: a person or an agent asks before sending.
// SeIn reads public chain facts and screens the message that asked for the payment. No key, no custody, nothing stored.
import { payCheck, RpcChainReader, scanTaskText, type PayFacts, type TeeChecker } from "@sealed-intent/core";
import { policyFrom, toSmallest, type Network } from "./setup";

export interface PayCheckOptions {
  /** checks one visitor may ask for in ten minutes */
  perVisitor: number;
  /** checks everyone together may ask for in a day */
  perDay: number;
  /** the enclave model; without it only the rules and the instruction screen answer */
  tee?: TeeChecker;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface PayCheckService {
  handle(visitor: string, body: Record<string, unknown>, now?: number): Promise<{ status: number; body: unknown }>;
  quota(now?: number): { checksLeft: number };
}

const RPC: Record<Network, string[]> = { mainnet: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.fastnear.com"], testnet: ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com"] };
const TXS: Record<Network, string> = { mainnet: "https://tx.main.fastnear.com", testnet: "https://tx.test.fastnear.com" };
const INDEX: Record<Network, string> = { mainnet: "https://api.nearblocks.io", testnet: "https://api-testnet.nearblocks.io" };
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const toNear = (yocto: string) => Number(BigInt(yocto) / 10n ** 20n) / 10_000;
const ms = (ns: string | number) => Number(BigInt(ns) / 1_000_000n);
const day = (now: number) => new Date(now).toISOString().slice(0, 10);

interface Paid { to: string; near?: number }
interface FastTx { transaction: { receiver_id: string; actions?: unknown[] } }
interface IndexTx { signer_account_id: string; receiver_account_id: string; actions?: { action: string }[]; actions_agg?: { deposit?: string }; outcomes?: { status?: boolean } }

export function createPayCheck(opts: PayCheckOptions): PayCheckService {
  const get = opts.fetch ?? fetch;
  const visits = new Map<string, number[]>();
  const born = new Map<string, number>();
  let today = "";
  let used = 0;
  const roll = (now: number) => {
    if (day(now) !== today) [today, used] = [day(now), 0];
  };
  const json = async <T>(url: string, body?: unknown): Promise<T | undefined> => {
    try {
      const res = await get(url, { ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
      return res.ok ? ((await res.json()) as T) : undefined;
    } catch {
      return undefined;
    }
  };

  /** when the account first appeared; the indexer knows the creation, the transaction log is the fallback */
  async function createdAt(network: Network, id: string): Promise<number | undefined> {
    const key = `${network}:${id}`;
    if (born.has(key)) return born.get(key);
    const made = (await json<{ data?: { created?: { block_timestamp?: string } } }>(`${INDEX[network]}/v3/accounts/${encodeURIComponent(id)}`))?.data?.created?.block_timestamp;
    const first = made ?? (await json<{ account_txs?: { tx_block_timestamp: string }[] }>(`${TXS[network]}/v0/account`, { account_id: id, desc: false }))?.account_txs?.[0]?.tx_block_timestamp;
    if (!first) return undefined;
    if (born.size > 2000) born.clear();
    born.set(key, ms(first));
    return ms(first);
  }

  /** the payer's recent outgoing transactions: who received them and how much NEAR */
  async function outgoing(network: Network, payer: string): Promise<Paid[] | undefined> {
    const list = (await json<{ account_txs?: { transaction_hash: string; is_success?: boolean }[] }>(`${TXS[network]}/v0/account`, { account_id: payer, is_signer: true }))?.account_txs;
    if (list) {
      const hashes = list.filter((t) => t.is_success !== false).slice(0, 40).map((t) => t.transaction_hash);
      const parts = await Promise.all([hashes.slice(0, 20), hashes.slice(20)].filter((h) => h.length).map((h) => json<{ transactions?: FastTx[] }>(`${TXS[network]}/v0/transactions`, { tx_hashes: h })));
      if (parts.every((p) => p?.transactions))
        return parts.flatMap((p) =>
          p!.transactions!.map((t) => {
            const sent = (t.transaction.actions ?? []).flatMap((a) => (a && typeof a === "object" && "Transfer" in a ? [toNear(String((a as { Transfer: { deposit: string } }).Transfer.deposit))] : []));
            return { to: t.transaction.receiver_id, near: sent.length ? sent.reduce((x, y) => x + y, 0) : undefined };
          }),
        );
    }
    const rows = (await json<{ data?: IndexTx[] }>(`${INDEX[network]}/v3/accounts/${encodeURIComponent(payer)}/txns?limit=100`))?.data;
    return rows?.filter((t) => t.signer_account_id === payer && t.outcomes?.status !== false).map((t) => ({ to: t.receiver_account_id, near: t.actions?.some((a) => a.action === "TRANSFER") && t.actions_agg?.deposit ? toNear(t.actions_agg.deposit) : undefined }));
  }

  return {
    quota(now = Date.now()) {
      roll(now);
      return { checksLeft: Math.max(0, opts.perDay - used) };
    },
    async handle(visitor, body, now = Date.now()) {
      roll(now);
      const recent = (visits.get(visitor) ?? []).filter((t) => now - t < 600_000);
      if (recent.length >= opts.perVisitor) return { status: 429, body: { error: "You have checked a lot in a few minutes. Wait a little and try again." } };
      if (used >= opts.perDay) return { status: 429, body: { error: "Today's free checks are used up. Come back tomorrow, or run SeIn yourself." } };

      const network: Network = body.network === "testnet" ? "testnet" : "mainnet";
      const to = String(body.to ?? "").trim().toLowerCase();
      const payer = String(body.from ?? "").trim().toLowerCase() || undefined;
      const taskText = String(body.taskText ?? "").slice(0, 1000);
      const amount = String(body.amount ?? "").trim();
      if (!ACCOUNT.test(to)) return { status: 400, body: { error: "The receiver must be a NEAR account name." } };
      if (payer && !ACCOUNT.test(payer)) return { status: 400, body: { error: "The paying account must be a NEAR account name." } };
      if (payer === to) return { status: 400, body: { error: "The payer and the receiver are the same account." } };
      let yocto = "1";
      try {
        if (amount) yocto = toSmallest(amount, 24);
      } catch {
        return { status: 400, body: { error: "The amount must be a number of NEAR, like 2.5." } };
      }
      if (visits.size > 5000) visits.clear();
      visits.set(visitor, [...recent, now]);
      used++;
      const started = Date.now();

      const chain = new RpcChainReader(RPC[network], get);
      const [receiver, age, balance, paid] = await Promise.all([
        chain.account(to).catch(() => undefined),
        createdAt(network, to),
        payer ? json<{ result?: { amount?: string } }>(RPC[network][0]!, { jsonrpc: "2.0", id: "check", method: "query", params: { request_type: "view_account", finality: "final", account_id: payer } }) : undefined,
        payer ? outgoing(network, payer) : undefined,
      ]);

      let paidBefore: Record<string, number> | undefined;
      const pastAmounts: number[] = [];
      if (paid) {
        paidBefore = {};
        for (const p of paid) {
          if (p.to === payer) continue;
          paidBefore[p.to] = (paidBefore[p.to] ?? 0) + 1;
          if (p.near) pastAmounts.push(p.near);
        }
      }
      const known = Object.keys(paidBefore ?? {});
      const injectionCodes = taskText ? scanTaskText(taskText, [to, ...(payer ? [payer] : []), ...known]).codes : [];

      const facts: PayFacts = {
        to,
        payer,
        amountNear: amount ? Number(amount) : undefined,
        receiver: receiver ? { exists: receiver.exists, isContract: receiver.isContract, createdAt: age } : undefined,
        paidBefore,
        pastAmounts,
        balanceNear: balance?.result?.amount ? toNear(balance.result.amount) : undefined,
        injectionCodes,
        now,
      };

      // the model's opinion, from inside an enclave; not asked when the rules already refuse, and a failure only removes the opinion
      let enclave: PayFacts["enclave"];
      if (opts.tee && taskText && payCheck(facts).verdict !== "BLOCK") {
        const who = payer ?? "the-payer.near";
        const policy = policyFrom({ network, owner: who, wallet: who, perPaymentUsd: 1_000_000, dailyUsd: 1_000_000, receivers: known.slice(0, 40), newReceiver: "warn", tokens: ["NEAR"], enclave: true });
        const opinion = await Promise.race([
          opts.tee.check({ intent: { kind: "transfer", purpose: "general", token: "native", amount: yocto, recipient: to, taskText }, policy, injectionCodes, amountText: amount ? `${amount} NEAR` : undefined }).catch(() => undefined),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 45_000)),
        ]);
        if (opinion) enclave = { signal: opinion.signal, attested: opinion.kind === "nearai-cloud" && opinion.attestation.quoteVerifiedLocally && opinion.attestation.signingAddressMatched };
      }

      const result = payCheck({ ...facts, enclave });
      opts.log?.(`check: ${result.verdict} on ${network} in ${((Date.now() - started) / 1000).toFixed(1)} s${taskText && opts.tee && !enclave && result.verdict !== "BLOCK" ? " (no enclave opinion)" : ""}`);
      return {
        status: 200,
        body: {
          network,
          ...result,
          facts: {
            receiver: facts.receiver ? { exists: facts.receiver.exists, isContract: facts.receiver.isContract, ageDays: age ? Math.floor((now - age) / 86_400_000) : null } : null,
            payer: payer ? { receiversSeen: paidBefore ? known.length : null, balanceNear: facts.balanceNear ?? null } : null,
            enclave: enclave ?? null,
          },
          checkedAt: new Date(now).toISOString(),
          note: "Advice from public chain data. Nothing was sent, and nothing about this check is kept.",
        },
      };
    },
  };
}
