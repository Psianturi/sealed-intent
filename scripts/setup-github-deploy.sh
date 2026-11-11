#!/usr/bin/env bash
# Lets GitHub Actions deploy to Cloud Run without a stored key: a service account that only this repo's
# main branch can act as, through Workload Identity Federation. Run once, after scripts/deploy-cloudrun.sh.
#   GCP_PROJECT=my-project GITHUB_REPO=owner/repo bash scripts/setup-github-deploy.sh
set -euo pipefail
PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REPO="${GITHUB_REPO:?set GITHUB_REPO, like owner/repo}"
GCLOUD="${GCLOUD:-$(command -v gcloud || echo /d/tools/google-cloud-sdk/bin/gcloud.cmd)}"
gcloud() { "$GCLOUD" "$@"; }

NUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA="github-deployer@$PROJECT.iam.gserviceaccount.com"
RUNNER="$NUM-compute@developer.gserviceaccount.com"
POOL=github
PROVIDER=sealed-intent

gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT" >/dev/null
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 ||
  gcloud iam service-accounts create github-deployer --project "$PROJECT" --display-name "GitHub deploy" >/dev/null
for role in roles/run.sourceDeveloper roles/serviceusage.serviceUsageConsumer roles/logging.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null
done
gcloud iam service-accounts add-iam-policy-binding "$RUNNER" --project "$PROJECT" --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser >/dev/null

gcloud iam workload-identity-pools describe "$POOL" --project "$PROJECT" --location global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create "$POOL" --project "$PROJECT" --location global --display-name "GitHub" >/dev/null
gcloud iam workload-identity-pools providers describe "$PROVIDER" --project "$PROJECT" --location global --workload-identity-pool "$POOL" >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project "$PROJECT" --location global --workload-identity-pool "$POOL" \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository=='$REPO' && assertion.ref=='refs/heads/main'" >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUM/locations/global/workloadIdentityPools/$POOL/attribute.repository/$REPO" >/dev/null

echo "workload_identity_provider: projects/$NUM/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER"
echo "service_account: $SA"
