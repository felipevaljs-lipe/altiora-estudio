#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Altiora Estudio — provision the Playground API (Polly + Comprehend).
#
# Creates: a Lambda, its role, an API Gateway HTTP API with POST routes
# /playground/polly and /playground/comprehend, CORS locked to the site, and
# STAGE-LEVEL THROTTLING (burst + steady rate) so the public demos can't be
# hammered into a big bill.
#
# Prereqs: AWS CLI v2 configured for account 229975483756.
# Run from anywhere:  bash aws/setup-playground.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="us-east-1"
ACCOUNT_ID="229975483756"
FUNCTION_NAME="AltioraPlayground"
ROLE_NAME="AltioraPlaygroundRole"
API_NAME="AltioraPlaygroundApi"
ORIGINS="https://altioraestudio.com,https://www.altioraestudio.com"

# Throttling: steady 5 req/s, burst 10. Low — these are interactive demos,
# not a high-traffic API. Protects against scripted hammering.
THROTTLE_RATE=5
THROTTLE_BURST=10

echo "==> 1. Role"
aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  2>/dev/null && echo "   created." || echo "   exists."
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name "AltioraPlaygroundAccess" \
  --policy-document file://aws/lambda-playground-policy.json
echo "   policy attached."
sleep 10

echo "==> 2. Lambda"
( cd aws/lambda-playground && zip -q -r ../lambda-playground.zip index.mjs )
aws lambda create-function --region "$REGION" --function-name "$FUNCTION_NAME" \
  --runtime nodejs20.x --handler index.handler \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}" \
  --zip-file fileb://aws/lambda-playground.zip --timeout 20 \
  --environment "Variables={ALLOWED_ORIGINS=$ORIGINS}" \
  2>/dev/null && echo "   created." \
  || ( aws lambda update-function-code --region "$REGION" --function-name "$FUNCTION_NAME" \
         --zip-file fileb://aws/lambda-playground.zip >/dev/null && \
       aws lambda update-function-configuration --region "$REGION" --function-name "$FUNCTION_NAME" \
         --environment "Variables={ALLOWED_ORIGINS=$ORIGINS}" >/dev/null && echo "   updated." )

echo "==> 3. HTTP API"
API_ID=$(aws apigatewayv2 get-apis --region "$REGION" \
  --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null)
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  API_ID=$(aws apigatewayv2 create-api --region "$REGION" --name "$API_NAME" \
    --protocol-type HTTP \
    --cors-configuration "AllowOrigins=https://altioraestudio.com,https://www.altioraestudio.com,AllowMethods=POST,OPTIONS,AllowHeaders=content-type" \
    --query ApiId --output text)
  echo "   created API: $API_ID"
else
  echo "   reusing API: $API_ID"
fi

LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"
INTEGRATION_ID=$(aws apigatewayv2 get-integrations --region "$REGION" --api-id "$API_ID" \
  --query "Items[0].IntegrationId" --output text 2>/dev/null)
if [ "$INTEGRATION_ID" = "None" ] || [ -z "$INTEGRATION_ID" ]; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --region "$REGION" --api-id "$API_ID" \
    --integration-type AWS_PROXY --integration-uri "$LAMBDA_ARN" \
    --payload-format-version 2.0 --query IntegrationId --output text)
fi
echo "   integration: $INTEGRATION_ID"

for ROUTE in "POST /playground/polly" "POST /playground/comprehend"; do
  aws apigatewayv2 create-route --region "$REGION" --api-id "$API_ID" \
    --route-key "$ROUTE" --target "integrations/$INTEGRATION_ID" 2>/dev/null \
    && echo "   route: $ROUTE" || echo "   route exists: $ROUTE"
done

echo "==> 4. Stage with throttling"
aws apigatewayv2 create-stage --region "$REGION" --api-id "$API_ID" \
  --stage-name '$default' --auto-deploy \
  --default-route-settings "ThrottlingRateLimit=$THROTTLE_RATE,ThrottlingBurstLimit=$THROTTLE_BURST" \
  2>/dev/null && echo "   stage created." \
  || ( aws apigatewayv2 update-stage --region "$REGION" --api-id "$API_ID" --stage-name '$default' \
         --default-route-settings "ThrottlingRateLimit=$THROTTLE_RATE,ThrottlingBurstLimit=$THROTTLE_BURST" >/dev/null \
       && echo "   stage throttle updated." )

echo "==> 5. Invoke permission"
aws lambda add-permission --region "$REGION" --function-name "$FUNCTION_NAME" \
  --statement-id "apigw-invoke-playground" --action "lambda:InvokeFunction" \
  --principal "apigateway.amazonaws.com" \
  --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" \
  2>/dev/null && echo "   added." || echo "   exists."

ENDPOINT=$(aws apigatewayv2 get-api --region "$REGION" --api-id "$API_ID" --query ApiEndpoint --output text)
echo ""
echo "Done. Playground endpoints:"
echo "  ${ENDPOINT}/playground/polly"
echo "  ${ENDPOINT}/playground/comprehend"
echo ""
echo "Put ${ENDPOINT} in environment.ts/.prod as playground.apiUrl, then rebuild."
