#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Altiora Estudio — activate the Bedrock Lambda on the FallbackIntent.
#
# Lex V2 has TWO flags on a code hook: `enabled` (it exists) and `active`
# (Lex actually calls it). The console can leave a FallbackIntent with
# enabled:true / active:false, plus a static initialResponse whose nextStep
# points at a disabled dialog hook — so the Lambda is never invoked and the
# user just sees the static "no te entendí" message.
#
# This script forces the correct state:
#   - fulfillmentCodeHook: enabled=true, active=true
#   - dialogCodeHook: disabled
#   - removes the static initialResponse (fallback flows straight to the Lambda)
# then rebuilds the locale so the change is live on the test alias.
#
# Re-run this any time the bot/intent is recreated. Idempotent.
# Run from anywhere:  bash aws/fix-fallback-hook.sh
# ---------------------------------------------------------------------------
set -euo pipefail

REGION="us-east-1"
BOT_ID="6COPKGRTBN"
BOT_VERSION="DRAFT"
LOCALE_ID="es_419"
INTENT_ID="FALLBCKINT"

echo "==> Activating the fulfillment code hook on FallbackIntent"
aws lexv2-models update-intent \
  --bot-id "$BOT_ID" \
  --bot-version "$BOT_VERSION" \
  --locale-id "$LOCALE_ID" \
  --intent-id "$INTENT_ID" \
  --intent-name FallbackIntent \
  --parent-intent-signature AMAZON.FallbackIntent \
  --dialog-code-hook '{"enabled":false}' \
  --fulfillment-code-hook '{"enabled":true,"active":true,"postFulfillmentStatusSpecification":{"successNextStep":{"dialogAction":{"type":"EndConversation"},"intent":{}},"failureNextStep":{"dialogAction":{"type":"EndConversation"},"intent":{}},"timeoutNextStep":{"dialogAction":{"type":"EndConversation"},"intent":{}}}}' \
  --region "$REGION" \
  --query "fulfillmentCodeHook.{enabled:enabled,active:active}" --output json

echo "==> Rebuilding the $LOCALE_ID locale"
aws lexv2-models build-bot-locale \
  --bot-id "$BOT_ID" --bot-version "$BOT_VERSION" --locale-id "$LOCALE_ID" \
  --region "$REGION" --query "botLocaleStatus" --output text

echo ""
echo "Build started. Check status with:"
echo "  aws lexv2-models describe-bot-locale --bot-id $BOT_ID --bot-version $BOT_VERSION --locale-id $LOCALE_ID --region $REGION --query botLocaleStatus --output text"
echo "Wait until it reads 'Built', then test in the chat."
