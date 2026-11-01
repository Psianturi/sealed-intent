# Real runs on NEAR testnet

Test tokens with no value. Real: the chain, OutLayer custody, NEAR AI Cloud, the 1Click price list. Not covered: swaps, because NEAR Intents does not exist on testnet.

- Custody wallet: `f79de341d4627a69d31b850a515c1e9c282dbbdd2ac8933aca34129a8912fe21`
- Policy controller: `sein-owner-mvy1eh5f.testnet`
- Registry contract: `sein-registry-mvy2i59w.testnet`, agent `agent-1`

## Custody on its own, without SeIn

`pnpm custody:check` sends each attempt straight to OutLayer with the wallet's API key. File: `s3-direct-attempts.json`. Policy: `policy.json`.

| Attempt | OutLayer | Result |
|---|---|---|
| wrap 0.5 NEAR on the allowed contract | signed | as expected |
| native NEAR to the allowed vendor | signed | as expected |
| native NEAR to the attacker | refused | as expected |
| native NEAR above the per-transaction limit | refused | as expected |
| wNEAR to the allowed vendor | signed | as expected |
| wNEAR to the attacker through the allowed token contract | signed | **not refused** |
| wNEAR above the token limit to the vendor | signed | **not refused** |
| wNEAR to the attacker with ft_transfer_call | signed | **not refused** |
| call a contract that is not on the list | refused | as expected |
| sign a NEP-413 message | refused | as expected |
| delete the wallet and sweep to the attacker | refused | as expected |
| intents withdraw to the attacker | refused | as expected |
| key holder plus another account replaces the policy | refused | as expected |
| the wallet replaces its own policy through a call | refused | as expected |
| another account deletes the policy | refused | as expected |
| a freeze-only key freezes the wallet | signed | as expected |
| frozen wallet: a payment that was allowed | refused | as expected |
| the freeze-only key cannot unfreeze | refused | as expected |
| another account unfreezes | refused | as expected |
| the controller unfreezes | signed | as expected |
| after unfreeze the allowed payment works again | signed | as expected |

18 of 21 as expected. **With a token contract on the address list, OutLayer judges a plain contract call by its outer fields, so it does not check who receives a token or how much.** The wNEAR really moved: 1000000000000000000000 yocto reached the attacker account in this run.

With the hardened policy (`policy-hardened.json`: native transfers only, no contract calls) 8 of 8 went as expected, and no token could move at all. File: `s3-hardened.json`.

A policy shaped like the planned mainnet swap (`policy-token-lane.json`: one token contract on the list, tiny native limits) gave 7 of 8. Native NEAR is protected, and a token transfer to a stranger still goes through. Its daily limit is set above what this wallet had already spent that day. The mainnet version is `fixtures/custody-policy.mainnet.example.json`.

## The whole path through SeIn

`pnpm custody:flow`. File: `s4-flow.json`, signed receipts in `receipts/`, Merkle proofs in `proofs/`.

| Step | Verdict | Owner | Result | On chain |
|---|---|---|---|---|
| Routine NEAR payment to the vendor | ALLOW |  | submitted | [tx](https://testnet.nearblocks.io/txns/CY18AusJNA6vDqCnrAAF2FNVXrV1rdWkpqy1T56eWY5R), matches the request |
| Routine wNEAR payment to the vendor | ALLOW |  | submitted | [tx](https://testnet.nearblocks.io/txns/6knyWkmh3oxtMfWeKr7JPKH7MWrQzdVpRsihmH1yfhHJ), matches the request |
| New recipient, the owner approves, custody also allows | WARN | approved | submitted | [tx](https://testnet.nearblocks.io/txns/jHfPVh1W5oC5TxFHcAwfLDTLcMNXwQM3MXB2Ggcwrci), matches the request |
| New recipient, the owner rejects | WARN | rejected | nothing sent |  |
| A careless owner approves the attacker, custody refuses | WARN | approved | not_sent, custody refused |  |
| wNEAR to the attacker, which custody alone would let through; the owner rejects | WARN | rejected | nothing sent |  |
| Tricked agent: hidden instruction in the task text | BLOCK |  | nothing sent |  |
| Above the secret per-transaction limit | BLOCK |  | nothing sent |  |
| Owner freeze: a routine payment is refused | BLOCK |  | nothing sent |  |
| Forbidden action freezes the wallet | BLOCK |  | nothing sent |  |

10 of 10 as expected. Enclave objections go to the owner in this run so the approval path is exercised. `s4-enclave-objections-block.json` is an earlier run where they block outright, which is the default.

## A payment that skips SeIn

One transfer was sent straight to custody ([tx](https://testnet.nearblocks.io/txns/3JERjb5v8jd9ZGg6qEwmW2GnYsUzATzBjHVVmuYPnZyy)). Reconciliation runs every 60 seconds. It reported the transaction with no receipt after **62 seconds**, and the wallet was frozen on chain after **64 seconds** ([tx](https://testnet.nearblocks.io/txns/7Hb2tPHBUuU3MQ1eLTWegjorc26Kv5rcBZ2fpfFhD62S)), using a key that can do nothing but freeze. The next direct transfer got HTTP 403 `wallet_frozen`.
