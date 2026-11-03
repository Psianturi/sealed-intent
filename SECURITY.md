# Security

SeIn has not been audited. Do not put in funds you cannot lose. Report problems privately to the repository owner.

## What it defends against

An agent that was tricked, by a poisoned message, a bad tool or a fake contact, and now asks to do something the owner would not want. SeIn stands between the request and the signature.

| Threat | What stops it | Tested by |
|---|---|---|
| Agent told to pay a stranger | Receiver rules, first-contact and new-account signals, injection screen, enclave opinion | Red team, Arena, `pnpm custody:flow` |
| Payment hidden inside a normal request (second action, added key, signing a message) | Action classes, contract and method lists; forbidden kinds freeze the wallet | Red team, Arena |
| Bad deal, look-alike token, quote changed after the check | Signed quote, value-loss limit, dry and live comparison | Red team, Arena |
| Agent searching for its spending limit | Generic refusal code; three limit refusals in an hour freeze the wallet | `packages/core/test/privacy.test.ts` |
| A request sent straight to custody with a stolen key | Custody policy for native NEAR; reconciliation for everything, which freezes the wallet on chain | `pnpm custody:check`, `pnpm custody:flow` |
| A key or code added to the account by another path | Account watcher freezes the wallet | Gated test on a local NEAR node |
| An old receipt rewritten, or one made up later | Issuer signature, Merkle root on the registry, period checks | Contract tests, `apps/web` verify page |
| A stolen agent token | Agent signing key, one use per signed request, revocation | `apps/server/test/gateway.test.ts` |
| A forged approval | Wallet signature over what the owner was shown, checked against the chain | `apps/server/test/gateway.test.ts`, `pnpm custody:flow` |
| Another website calling the owner's gateway | Browser calls only from `SEALED_WEB_ORIGINS`, only on the review, approve, reject and freeze routes, and a one-time key per review | `apps/server/test/approve-page.test.ts` |

## What it does not defend against

- **A compromised SeIn host with root.** It holds the custody key. Native NEAR stays bound by the custody policy and reconciliation still raises the alarm, but only if the watcher runs somewhere else.
- **A stolen custody key while token contracts are on the custody list.** OutLayer judges a plain contract call by its outer fields, so it does not check who receives a token or how much. This was tested live, see [`evidence/custody-testnet`](evidence/custody-testnet). Reconciliation sees it after the fact, so the loss is bounded by one interval and what the wallet holds. Keep the balance small, or hold native NEAR under the hardened policy.
- **An owner who approves without reading.** The lazy recording in the Arena measures this.
- **A bug inside a token or a lying data source.** Shown on purpose as out of scope in the Arena.
- **Reading a public chain.** A receipt keeps the amount and receiver sealed, but its transaction hash points to public data. Anyone who follows it sees that transaction. Keep the receipt link private if that matters, or use the confidential route.
- **Limit discovery with a good first guess.** See the README. Freezing limits the attempts, it does not remove the leak.

Who first stores a custody policy becomes its controller, and anyone holding the API key can do it on a wallet with no policy. Store the policy before the key goes anywhere.

## Keys

| Key | Who holds it | What it can do if stolen |
|---|---|---|
| Custody API key | SeIn host only | Anything the custody policy allows |
| Owner wallet key | The owner, never the server | Everything. Use a real wallet, not a file |
| Freeze-only key | SeIn host | Freeze the wallet. It cannot unfreeze, pay or change the policy |
| Registry operator key | SeIn host | Add receipt batches and issuer keys. It cannot touch an agent or any money |
| Receipt issuer key | SeIn host | Sign receipts. Retire it on the registry and old receipts stay dated |
| Agent token and signing key | The agent's host | Ask for decisions, which still go through every check |

## In an emergency

1. **Stop the money.** `pnpm owner freeze "reason"` stops SeIn and, with a freeze key configured, freezes custody on chain. If the server is down, freeze from the OutLayer dashboard or call `freeze_wallet` on the OutLayer contract with the controller account.
2. **Cut off the agent.** `pnpm owner agent-revoke <agentId>`. It takes effect on the next request.
3. **See what happened.** `pnpm owner status`, then the OutLayer audit log and the explorer for the custody account. Reconciliation lists any transaction with no receipt.
4. **Move the funds.** From the OutLayer dashboard with the controller account. Only the controller can change the policy or unfreeze.
5. **Replace what leaked.** New custody wallet and policy, a new issuer key on the registry, new agent tokens. Set the registry status of the old agent to Frozen or Retired, which only its owner can do.
6. **Reopen.** `pnpm owner reconcile-accept` once you have read the history, then `pnpm owner unfreeze` and the on-chain unfreeze.

## Scanning

`pnpm secret:scan` looks through every version of every tracked file and runs in CI, together with the tests, the red team, the isolation check and a dependency audit.
