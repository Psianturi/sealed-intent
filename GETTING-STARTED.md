# Getting started: put SeIn between your agent and its money

About 15 minutes. You need a computer with Node.js 22.13 or newer, a NEAR wallet you control, and a little NEAR.
Try it on testnet first; the steps are the same on mainnet.

## How the pieces fit

```
 your AI agent  --asks "pay 0.1 NEAR to bob.near"-->  SeIn on your computer  --only if allowed-->  OutLayer custody wallet  -->  NEAR
 (Claude, Cursor,           holds no key                 five checks, your                     holds the money and the key
  your own code)                                         secret rules                          inside an enclave
                                                              |
                                                              +--> "needs you": a link; you approve with your NEAR wallet
```

- **The custody wallet** holds the money. You create it in the OutLayer dashboard. Its key never leaves OutLayer's enclave.
- **SeIn** runs on your computer. It holds the wallet's API key, so it is the only way to move money. Your agent does not get that key.
- **Your agent** asks SeIn to pay. It gets one of three answers: paid, waiting for you, or refused.
- **You** answer "waiting for you" with a signature from your own NEAR wallet, in the browser.

## 1. Get the code (once)

```bash
git clone https://github.com/Psianturi/sealed-intent.git
cd sealed-intent
corepack enable
pnpm install
```

On Windows PowerShell, use `pnpm.cmd` wherever this guide says `pnpm`.

## 2. Create the custody wallet (OutLayer dashboard)

1. Open https://app.outlayer.ai and choose the network (testnet first).
2. Create an agent custody wallet and copy its **API key** (it starts with `wk_`). Keep it private.
3. **Before the key goes anywhere,** set the wallet's policy in the dashboard and sign it with **your own NEAR wallet**. The first account that stores a policy becomes its controller, and only the controller can change or unfreeze it later.
   A good first policy: transfers only, native NEAR only, a short list of receivers (yours plus the ones you trust), a per-payment and a daily limit.
4. Send a little NEAR to the wallet's address.

This policy is the second lock: even if SeIn were bypassed, OutLayer refuses what the policy does not allow.

## 3. Set up SeIn

```bash
pnpm sein setup
```

It asks five things: the network, the custody API key, your NEAR account, your rules (tokens, largest payment, daily limit, receivers it may pay without asking, and what to do with anyone else), and optionally a NEAR AI Cloud key for the check that spots a tricked agent (https://cloud.near.ai).

Everything is saved in the folder `my-sein` on your computer. The rules are encrypted; the agent never learns them.

```bash
pnpm sein doctor
```

Checks the key, the wallet, who controls its policy, the balance, your account, the rules and the NEAR AI key, and tells you what to fix.

## 4. Start SeIn

```bash
pnpm sein start
```

Keep this window open. When a payment needs you, it appears here:

```
Waiting for you: shop-bot wants to pay 0.5 NEAR to newshop.near (about $1.90).
Flagged: RECIPIENT_NOT_ALLOWLISTED, COUNTERPARTY_FIRST_CONTACT. Approve or reject with your wallet:
https://sein-near.vercel.app/approve/...
```

Open the link on the same computer, read what is asked, and sign with your NEAR wallet. The link carries the address of your SeIn and a one-time key after `#`, so the website never receives them.

## 5. Connect your agent

In a second window:

```bash
pnpm sein connect shop-bot
```

This gives the agent its own token and signing key, and writes ready settings into `my-sein/agents/shop-bot/`. You do not build an MCP server or an API: SeIn already is one. Pick where your agent runs:

| Your agent | What to do |
|---|---|
| Claude Desktop | `pnpm sein connect shop-bot --install claude-desktop`, then restart Claude Desktop |
| Claude Code | run the command in `claude-code.txt` |
| Cursor, Windsurf | paste `mcp.json` into the MCP settings |
| VS Code | copy `vscode-mcp.json` to `.vscode/mcp.json` |
| Your own code, any language | load `agent.env` and call the REST API; `examples/rest-agent.mjs` is a working example |

Then just ask the agent: *"Pay 0.01 NEAR to bob.near for the October invoice."*

The agent sees two simple tools:

- `pay` with the receiver, the amount in normal units (0.01) and the token (NEAR, USDC or wNEAR). The answer is paid, waiting for the owner, or refused.
- `finish_payment` with the decision id, once you approved a payment that was waiting.

With your own code:

```bash
node examples/rest-agent.mjs my-sein/agents/shop-bot/agent.env pay bob.near 0.01 NEAR "Pay Bob for the October invoice"
node examples/rest-agent.mjs my-sein/agents/shop-bot/agent.env finish <decisionId>
```

## 6. Day to day

| You want to | Run |
|---|---|
| See what waits for you | `pnpm sein pending` |
| Stop every payment now | `pnpm sein freeze` |
| Allow payments again | `pnpm sein unfreeze` |
| Check everything | `pnpm sein doctor` |

Every decision leaves a signed receipt that anyone can check at https://sein-near.vercel.app/verify.html without seeing the amount or the receiver.

## What happens to a payment

1. **Deal real?** For a swap, the NEAR Intents quote must be signed and close to the reference price.
2. **Who gets it?** A known receiver passes; a new one asks you (or is refused, if you chose that).
3. **A payment?** Only transfers, swaps and allowed calls. Adding keys, deploying code or deleting the account is never allowed and freezes the wallet.
4. **Tricked?** The task text is screened, and a model inside a NEAR AI Cloud enclave gives its opinion.
5. **In budget?** Per payment, per hour and per day, in dollars.

Then SeIn answers ALLOW (custody pays), WARN (you decide) or BLOCK (nothing moves). If a transaction ever leaves the wallet without a SeIn receipt, SeIn notices within about a minute and stops every payment. To have it also freeze the custody wallet on chain, give it a key that can only freeze (see INTEGRATING.md).

## Mainnet checklist

- Start with a small balance you can afford to lose. SeIn has not been audited.
- In the OutLayer policy, list only native NEAR unless you need tokens: OutLayer checks a token transfer by its contract, not by its receiver, so a listed token contract can pay anyone. SeIn still checks the receiver.
- Give mainnet its own folder, so nothing from testnet carries over: `pnpm sein setup --dir my-sein-mainnet`, and add `--dir my-sein-mainnet` to every `pnpm sein` command for it.
- Run `pnpm sein doctor --dir my-sein-mainnet` until every line says `ok`.

Details for developers: [INTEGRATING.md](INTEGRATING.md). Threat model and limits: [SECURITY.md](SECURITY.md).
