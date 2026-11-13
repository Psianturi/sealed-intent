# One payment and one refusal on NEAR mainnet

Run once on 13 November 2026 with real NEAR, small amounts. SeIn ran in live mode against an OutLayer custody wallet on
mainnet; the enclave check ran on NEAR AI Cloud. The agent side held no key.

| Step | Result | Where |
|---|---|---|
| The controller account stores the custody policy on `outlayer.near` | stored | [`65PTyS53…`](https://nearblocks.io/txns/65PTyS53uu7J2qPEkg6siK3vzHcxzwHWQS9kKDwczGYq) |
| The controller funds the custody wallet, after the policy is in place | 0.7 NEAR | [`5KiGr5gv…`](https://nearblocks.io/txns/5KiGr5gvUGyRnD5Yq4mEkCcBbCvLQgH7bh5VQE8kSHgo) |
| A request with pressure, secrecy and an unknown receiver | `BLOCK`, nothing sent | [`block-receipt.json`](block-receipt.json) |
| An ordinary invoice to a listed receiver | `ALLOW`, 0.005 NEAR paid by custody | [`allow-receipt.json`](allow-receipt.json), [`4GYCHxrb…`](https://nearblocks.io/txns/4GYCHxrbFFVPawDt5ugdeyWFjud2ehvpa17yegjZyPav) |

Accounts: custody wallet `019524dce6417ea37a76c81245268d7c43d86237b4dccfc94bec5f452f2ce1ff`, controller
`1e7f14ff1d363689ce9f0fae2ee965a91e54074d3813d4d3b6b144a484083185`. The custody policy is in
[`policy.json`](policy.json): transfers of native NEAR only, two listed receivers, 0.05 NEAR per payment.

Both receipts verify on the [verifier page](https://sein-near.vercel.app/verify.html) or with `pnpm verify`. The amount
and the receiver are sealed in the receipt; the transaction itself is public, as every NEAR transaction is.

What this does not show:

- The receipts are signed by the operator key and are **not anchored** in the registry contract, which lives on testnet.
- One payment is a proof that the path works on mainnet, not a measurement. The measured results are the recorded Arena run.
- Two earlier tries of the honest payment stopped at `WARN`: the enclave model objected to an ordinary request when the
  owner was an implicit (64 character) account and the limits differed from the demo's. Nothing was sent; in real use the
  owner would have been asked. The prompt now says that such names are ordinary accounts. This is a known weak spot of a
  model check and the reason the model can only make a decision stricter, never looser.
- No swap, no token transfer, no confidential route.
