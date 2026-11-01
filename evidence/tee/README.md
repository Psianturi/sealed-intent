# A real enclave check, kept as evidence

`pnpm tee:live` ran these on NEAR AI Cloud. **Real:** the Intel TDX and NVIDIA evidence, the TLS binding, the model's answer and its signature. **Simulated:** the chain and the executor, because no money moved. The policy is the demo policy, not a secret one, which is why the raw request can be published here.

| File | What it is |
|---|---|
| `summary.json` | One line per case: verdict, enclave answer, Intel status, GPUs, TLS binding |
| `routine.json`, `tricked.json` | The public receipt plus the exact request and response bytes |
| `routine.receipt.json`, `tricked.receipt.json` | The receipt alone, ready for the verify page |
| `routine.disclosure.json`, `tricked.disclosure.json` | One opened field: the receiver, a demo account |

To recheck, without any key:

```bash
pnpm verify evidence/tee/tricked.receipt.json
pnpm verify evidence/tee/tricked.receipt.json --disclose evidence/tee/tricked.disclosure.json
```

Or open https://sein-near.vercel.app/verify.html and choose a receipt. `packages/receipt/test/evidence.test.ts` also recomputes the hashes of the published request and response against the signed text, on every test run.

The Intel and NVIDIA verification happened at decision time and is recorded in `receipt.tee.attestation.checks`. A verifier of the receipt sees that record and the enclave's signature; to repeat the hardware checks themselves, run `pnpm tee:live` with your own key.

In the `tricked` case the model also returned `INTENT_QUOTE_MISMATCH` for a transfer, which has no quote. The opinion is a signal, not the judge, and that is one reason why.
