#!/usr/bin/env bash
# One-off: make the `gen` Cloud Function publicly INVOCABLE.
# The function's own code still enforces RBAC via the Firebase ID token (exactly
# like /doc, /docs, etc.) — "publicly invocable" is not "publicly authorized".
# Needed because the redeployed gen service lost the allUsers invoker binding.
set -euo pipefail

PROJECT="liquid-force-425209-g2"
REGION="us-central1"
SERVICE="gen"

echo "Granting allUsers run.invoker on ${SERVICE} (${REGION}) in ${PROJECT}..."
gcloud run services add-iam-policy-binding "${SERVICE}" \
  --region="${REGION}" \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --project="${PROJECT}"

echo "Done. /gen should now accept the browser preflight (204)."
