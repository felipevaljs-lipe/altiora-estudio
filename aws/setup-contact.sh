#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Altiora Estudio — provision the contact-form API.
#
# Creates: a Lambda (writes form submissions to the EstudioNubeLeads table +
# optional SES email), its role, an API Gateway HTTP API with POST /contact,
# and the invoke permission. Prints the endpoint URL to paste into the Angular
# environment (admin/contact apiUrl).
#
# Prereqs:
#   - AWS CLI v2 configured for account 229975483756.
#   - The EstudioNubeLeads table already exists (run aws/setup.sh first).
# Optional env:
#   - ALLOWED_ORIGIN='https://altioraestudio.com'  (lock CORS; default '*')
#   - SES_FROM / SES_TO  (enable email notifications)
# Run from anywhere:  bash aws/setup-contact.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="us-east-1"
ACCOUNT_ID="229975483756"
TABLE_NAME="EstudioNubeLeads"
FUNCTION_NAME="AltioraContactForm"
ROLE_NAME="AltioraContactFormRole"
API_NAME="AltioraContactApi"

ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-*}"

echo "==> 1. Creating role: $ROLE_NAME"
aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }' 2>/dev/null && echo "   created." || echo "   exists, skipping."

echo "==> 2. Attaching policy"
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "AltioraContactAccess" \
  --policy-document file://aws/lambda-contact-policy.json
echo "   attached."

echo "==> waiting 10s for IAM propagation"
sleep 10

echo "==> 3. Packaging the Lambda"
( cd aws/lambda-contact && zip -q -r ../lambda-contact.zip index.mjs )

# Build env var string (include SES_* only if provided)
ENV_VARS="LEADS_TABLE=$TABLE_NAME,ALLOWED_ORIGIN=$ALLOWED_ORIGIN"
if [ -n "${SES_FROM:-}" ] && [ -n "${SES_TO:-}" ]; then
  ENV_VARS="$ENV_VARS,SES_FROM=$SES_FROM,SES_TO=$SES_TO"
fi

echo "==> 4. Creating/updating the Lambda: $FUNCTION_NAME"
aws lambda create-function \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --runtime nodejs20.x \
  --handler index.handler \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}" \
  --zip-file fileb://aws/lambda-contact.zip \
  --timeout 15 \
  --environment "Variables={$ENV_VARS}" \
  2>/dev/null && echo "   created." \
  || ( echo "   exists — updating code + config." && \
       aws lambda update-function-code --region "$REGION" \
         --function-name "$FUNCTION_NAME" --zip-file fileb://aws/lambda-contact.zip >/dev/null && \
       aws lambda update-function-configuration --region "$REGION" \
         --function-name "$FUNCTION_NAME" --environment "Variables={$ENV_VARS}" >/dev/null && \
       echo "   updated." )

echo "==> 5. Creating HTTP API with POST /contact route"
API_ID=$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null)
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  API_ID=$(aws apigatewayv2 create-api \
    --region "$REGION" --name "$API_NAME" --protocol-type HTTP \
    --cors-configuration "AllowOrigins=${ALLOWED_ORIGIN},AllowMethods=POST,OPTIONS,AllowHeaders=content-type" \
    --target "arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}" \
    --query ApiId --output text)
  echo "   created API: $API_ID"
else
  echo "   reusing API: $API_ID"
fi

echo "==> 6. Allowing API Gateway to invoke the Lambda"
aws lambda add-permission \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --statement-id "apigw-invoke-contact" \
  --action "lambda:InvokeFunction" \
  --principal "apigateway.amazonaws.com" \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" \
  2>/dev/null && echo "   permission added." || echo "   permission exists, skipping."

ENDPOINT=$(aws apigatewayv2 get-api --region "$REGION" --api-id "$API_ID" --query ApiEndpoint --output text)

echo ""
echo "Done. Contact endpoint:"
echo "  ${ENDPOINT}/contact"
echo ""
echo "Put that URL in src/environments/environment.ts (and .prod) as"
echo "contact.apiUrl, then rebuild the Angular app."
