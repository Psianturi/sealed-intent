# Deploying the public SeIn (Cloud Run)

The website's **Try it** page talks to a hosted SeIn on NEAR testnet. Visitors play an agent and ask it to pay; the real checks answer, and an allowed payment is sent by a real OutLayer custody wallet with test tokens. This page puts that SeIn on Google Cloud Run.

## What runs there

- `apps/server/src/hosted.ts`: the normal SeIn gateway plus the public route `POST /v1/try`, which only the website may call from a browser.
- Its own testnet custody wallet, separate from the evidence wallet. Its OutLayer policy allows only the demo vendor and the owner, at most 0.02 NEAR per payment and 1 NEAR a day.
- Limits: 6 tries per visitor in ten minutes, 300 a day for everyone, 40 real payments a day. Each check calls NEAR AI Cloud, so these keep the bill small. Change them with `SEIN_DEMO_PER_VISITOR`, `SEIN_DEMO_PER_DAY` and `SEIN_DEMO_PAYMENTS_PER_DAY`.
- One instance that never sleeps (`--min-instances 1 --max-instances 1 --no-cpu-throttling`): the budget and history live in its local databases, and the reconciler and anchoring run on a timer. A restart starts them empty, which is fine for a demo; its receipts are already signed, and anchored on chain when the operator key is set.

## What you prepare (once)

1. A Google Cloud project with billing turned on. Note its project id.
2. The Google Cloud CLI on this computer, then `gcloud auth login`.
3. That's all. The deploy script enables Cloud Run, Cloud Build, Artifact Registry and Secret Manager itself.

## Deploy

From the repository root, with the `.env` that holds the demo wallet and the keys:

```bash
GCP_PROJECT=your-project-id bash scripts/deploy-cloudrun.sh
```

It stores every secret in Secret Manager without printing it, builds the container from the `Dockerfile`, deploys it to `asia-southeast2` (set `GCP_REGION` to change), and prints the service URL.

Then set `VITE_SEIN_API` to that URL in the Vercel project's environment variables and redeploy the site. The Try it page starts answering.

## Secrets it uses

| In Cloud Run | From `.env` | What it is |
|---|---|---|
| `OUTLAYER_API_KEY` | `SEIN_DEMO_OUTLAYER_API_KEY` | the demo custody wallet's key |
| `NEARAI_API_KEY` | `NEARAI_API_KEY` | NEAR AI Cloud, for the enclave check |
| `SEALED_POLICY_KEY` | `SEIN_HOSTED_POLICY_KEY` | encrypts the secret rules at rest, made by the script |
| `SEALED_OWNER_TOKEN` | `SEIN_HOSTED_OWNER_TOKEN` | the hosted owner token, made by the script |
| `SEALED_ISSUER_PEM` | `SEIN_HOSTED_ISSUER_PEM` | the receipt signing key, listed on the registry by `pnpm registry hosted-key` |
| `SEIN_OPERATOR_KEY` | `SEIN_OPERATOR_KEY` | optional: writes receipt batches to the registry |

## Keep it healthy

- **OutLayer policies now expire.** A policy signed through OutLayer carries `valid_until`, about seven days after signing. Re-sign the demo wallet's policy before it runs out, and before judging: `pnpm custody policy fixtures/custody-policy.demo-testnet.json` with the demo wallet's key and id in the environment.
- Top up the demo wallet with test NEAR when it runs low.
- Logs: `gcloud run services logs read sein --region asia-southeast2`.
