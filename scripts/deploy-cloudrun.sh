#!/usr/bin/env bash
# Deploys the public SeIn (testnet) to Cloud Run. Secrets are read from .env and stored in
# Secret Manager; nothing is printed. Needs gcloud, logged in.
#   GCP_PROJECT=my-project [GCP_REGION=asia-southeast2] bash scripts/deploy-cloudrun.sh
set -euo pipefail
PROJECT="${GCP_PROJECT:?set GCP_PROJECT to your Google Cloud project id}"
REGION="${GCP_REGION:-asia-southeast2}"
SERVICE="${SEIN_SERVICE:-sein}"
val() { grep "^$1=" .env | tail -1 | cut -d= -f2-; }
need() { [ -n "$(val "$1")" ] || { echo "$1 is missing from .env" >&2; exit 2; }; }
for k in SEIN_DEMO_OUTLAYER_API_KEY SEIN_DEMO_WALLET NEARAI_API_KEY SEIN_HOSTED_ISSUER_PEM; do need "$k"; done
# keys only the hosted SeIn uses, made once and kept in .env
for k in SEIN_HOSTED_POLICY_KEY SEIN_HOSTED_OWNER_TOKEN; do
  [ -n "$(val "$k")" ] || echo "$k=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" >> .env
done

gcloud config set project "$PROJECT" >/dev/null
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com >/dev/null
RUNNER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"

secret() {
  if gcloud secrets describe "$1" >/dev/null 2>&1; then printf '%s' "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  else printf '%s' "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic >/dev/null; fi
  gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$RUNNER" --role=roles/secretmanager.secretAccessor >/dev/null
  echo "secret $1 stored"
}
secret sein-outlayer-key "$(val SEIN_DEMO_OUTLAYER_API_KEY)"
secret sein-nearai-key "$(val NEARAI_API_KEY)"
secret sein-policy-key "$(val SEIN_HOSTED_POLICY_KEY)"
secret sein-owner-token "$(val SEIN_HOSTED_OWNER_TOKEN)"
secret sein-issuer-pem "$(val SEIN_HOSTED_ISSUER_PEM | sed 's/\n/\n/g')"
SECRETS="OUTLAYER_API_KEY=sein-outlayer-key:latest,NEARAI_API_KEY=sein-nearai-key:latest,SEALED_POLICY_KEY=sein-policy-key:latest,SEALED_OWNER_TOKEN=sein-owner-token:latest,SEALED_ISSUER_PEM=sein-issuer-pem:latest"
ENVS="SEALED_NETWORK=testnet,OUTLAYER_NEAR_ACCOUNT=$(val SEIN_DEMO_WALLET),SEIN_DEMO_OWNER=$(val SEIN_TESTNET_OWNER_ACCOUNT),SEIN_DEMO_RECEIVERS=$(val SEIN_TESTNET_VENDOR_ACCOUNT),NEARAI_MODEL=$(val NEARAI_MODEL)"
# with the operator key the hosted SeIn also writes its receipts to the registry on chain
if [ -n "$(val SEIN_OPERATOR_KEY)" ]; then
  secret sein-operator-key "$(val SEIN_OPERATOR_KEY)"
  SECRETS="$SECRETS,SEIN_OPERATOR_KEY=sein-operator-key:latest"
  ENVS="$ENVS,SEIN_REGISTRY_ACCOUNT=$(val SEIN_REGISTRY_ACCOUNT),SEIN_OPERATOR_ACCOUNT=$(val SEIN_OPERATOR_ACCOUNT)"
fi

# one instance that never sleeps: its databases live in memory and its watchers run on a timer
gcloud run deploy "$SERVICE" --source . --region "$REGION" --allow-unauthenticated \
  --min-instances 1 --max-instances 1 --no-cpu-throttling --cpu 1 --memory 1Gi --port 8080 --timeout 120 \
  --set-env-vars "$ENVS" --set-secrets "$SECRETS"
URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "SeIn is live at $URL"
curl -s "$URL/v1/try" && echo
echo "Last step: set VITE_SEIN_API=$URL on the Vercel project and redeploy the site."
