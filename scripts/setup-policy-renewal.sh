#!/usr/bin/env bash
# OutLayer signs a custody policy for seven days. This sets up a small Cloud Run job that signs the demo
# wallet's policy again, and a schedule that runs it every three days, so the public demo keeps working
# with nobody at a keyboard. The job is separate from SeIn on purpose: the SeIn service never holds the
# owner's key. Testnet only. Run once, after scripts/deploy-cloudrun.sh.
#   GCP_PROJECT=my-project bash scripts/setup-policy-renewal.sh
set -euo pipefail
PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:-asia-southeast2}"
SERVICE="${SEIN_SERVICE:-sein}"
JOB=sein-policy-renew
GCLOUD="${GCLOUD:-$(command -v gcloud || echo /d/tools/google-cloud-sdk/bin/gcloud.cmd)}"
gcloud() { "$GCLOUD" "$@"; }
val() { grep "^$1=" .env | tail -1 | cut -d= -f2-; }
for k in SEIN_TESTNET_OWNER_KEY SEIN_TESTNET_OWNER_ACCOUNT SEIN_DEMO_WALLET SEIN_DEMO_WALLET_ID; do [ -n "$(val "$k")" ] || { echo "$k is missing from .env" >&2; exit 2; }; done

gcloud services enable cloudscheduler.googleapis.com --project "$PROJECT" >/dev/null
NUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUNNER="$NUM-compute@developer.gserviceaccount.com"

if gcloud secrets describe sein-owner-key --project "$PROJECT" >/dev/null 2>&1; then printf '%s' "$(val SEIN_TESTNET_OWNER_KEY)" | gcloud secrets versions add sein-owner-key --project "$PROJECT" --data-file=- >/dev/null
else printf '%s' "$(val SEIN_TESTNET_OWNER_KEY)" | gcloud secrets create sein-owner-key --project "$PROJECT" --data-file=- --replication-policy=automatic >/dev/null; fi
gcloud secrets add-iam-policy-binding sein-owner-key --project "$PROJECT" --member="serviceAccount:$RUNNER" --role=roles/secretmanager.secretAccessor >/dev/null
echo "secret sein-owner-key stored"

# the job reuses the image the service already runs: same code, same policy file, nothing to build
IMAGE="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(spec.template.spec.containers[0].image)')"
gcloud run jobs deploy "$JOB" --project "$PROJECT" --region "$REGION" --image "$IMAGE" --quiet \
  --command node --args "node_modules/tsx/dist/cli.mjs,scripts/custody.ts,policy,fixtures/custody-policy.demo-testnet.json" \
  --max-retries 2 --task-timeout 300 --memory 1Gi \
  --set-env-vars "OUTLAYER_BASE_URL=https://testnet-api.outlayer.ai,OUTLAYER_NEAR_ACCOUNT=$(val SEIN_DEMO_WALLET),OUTLAYER_WALLET_ID=$(val SEIN_DEMO_WALLET_ID),SEIN_TESTNET_OWNER_ACCOUNT=$(val SEIN_TESTNET_OWNER_ACCOUNT)" \
  --set-secrets "OUTLAYER_API_KEY=sein-outlayer-key:latest,SEIN_TESTNET_OWNER_KEY=sein-owner-key:latest" >/dev/null
gcloud run jobs add-iam-policy-binding "$JOB" --project "$PROJECT" --region "$REGION" --member="serviceAccount:$RUNNER" --role=roles/run.invoker >/dev/null
echo "job $JOB ready"

URI="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$JOB:run"
if gcloud scheduler jobs describe "$JOB" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then VERB=update; else VERB=create; fi
gcloud scheduler jobs "$VERB" http "$JOB" --project "$PROJECT" --location "$REGION" --schedule "10 3 */3 * *" --time-zone "Etc/UTC" \
  --uri "$URI" --http-method POST --oauth-service-account-email "$RUNNER" >/dev/null
echo "schedule $JOB: every three days at 03:10 UTC"

gcloud run jobs execute "$JOB" --project "$PROJECT" --region "$REGION" --wait >/dev/null
gcloud logging read "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$JOB\"" --project "$PROJECT" --limit 6 --format='value(textPayload)' | grep -E "stored, tx|valid until|Error" || true
