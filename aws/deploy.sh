#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Altiora Estudio — build + deploy the SPA to S3 and invalidate CloudFront.
#
# Builds a production bundle, syncs it to the site bucket with sensible cache
# headers (hashed assets cached a year; index.html never cached), then
# invalidates CloudFront so visitors get the new version right away.
#
# Prereqs: AWS CLI v2 configured; the CloudFront distribution exists.
# Set DIST_ID once (export it or edit below) so invalidation runs.
# Run from anywhere:  bash aws/deploy.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="us-east-1"
BUCKET="estudioai-229975483756-us-east-1-an"
DIST_ID="${DIST_ID:-}"   # export DIST_ID=EXXXX': your CloudFront distribution id

echo "==> 1. Production build"
npm run build

# Angular 21 output path
DIST_DIR="dist/estudio-nube/browser"
if [ ! -d "$DIST_DIR" ]; then
  # Fallback for older output layout
  DIST_DIR="dist/estudio-nube"
fi
echo "   build output: $DIST_DIR"

echo "==> 2. Sync hashed assets (long cache)"
# Everything except index.html gets a long, immutable cache.
aws s3 sync "$DIST_DIR" "s3://$BUCKET" \
  --region "$REGION" \
  --delete \
  --exclude "index.html" \
  --cache-control "public,max-age=31536000,immutable"

echo "==> 3. Upload index.html (no cache)"
aws s3 cp "$DIST_DIR/index.html" "s3://$BUCKET/index.html" \
  --region "$REGION" \
  --cache-control "no-cache,no-store,must-revalidate" \
  --content-type "text/html"

if [ -n "$DIST_ID" ]; then
  echo "==> 4. Invalidating CloudFront ($DIST_ID)"
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" \
    --paths "/*" --query "Invalidation.Status" --output text
else
  echo "==> 4. Skipping CloudFront invalidation (DIST_ID not set)."
  echo "   Set it:  DIST_ID=EXXXX bash aws/deploy.sh"
fi

echo ""
echo "Deployed. https://altioraestudio.com"
