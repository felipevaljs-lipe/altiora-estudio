#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Altiora Estudio — provision the lead-capture backend for the Lex chatbot.
#
# Creates: DynamoDB table, Lambda execution role, the fulfillment Lambda.
# After running this, attach the Lambda to the bot alias and set it as the
# fulfillment code hook on the SolicitarServicio intent (see README.md).
#
# Prereqs: AWS CLI v2 configured with credentials for account 229975483756.
# Run from anywhere:  bash aws/setup.sh   (or  cd aws && bash setup.sh)
# ---------------------------------------------------------------------------
set -euo pipefail

# Always run from the project root (parent of this script's aws/ dir), so the
# relative file://aws/... and fileb://aws/... paths below resolve regardless of
# where the script was launched from.
cd "$(dirname "$0")/.."

REGION="us-east-1"
ACCOUNT_ID="229975483756"
TABLE_NAME="EstudioNubeLeads"
FUNCTION_NAME="EstudioNubeLeadFulfillment"
ROLE_NAME="EstudioNubeLeadLambdaRole"

echo "==> 1. Creating DynamoDB table: $TABLE_NAME"
aws dynamodb create-table \
  --region "$REGION" \
  --table-name "$TABLE_NAME" \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  2>/dev/null && echo "   created." || echo "   already exists, skipping."

echo "==> waiting for table to be ACTIVE"
aws dynamodb wait table-exists --region "$REGION" --table-name "$TABLE_NAME"

echo "==> 1b. Enabling TTL on the 'ttl' attribute (used by rate-limit guards)"
aws dynamodb update-time-to-live \
  --region "$REGION" \
  --table-name "$TABLE_NAME" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  2>/dev/null && echo "   TTL enabled." || echo "   TTL already set, skipping."

echo "==> 2. Creating Lambda execution role: $ROLE_NAME"
aws iam create-role \
  --role-name "$ROLE_NAME" \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }' 2>/dev/null && echo "   created." || echo "   already exists, skipping."

echo "==> 3. Attaching inline policy to the role"
aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "EstudioNubeLeadAccess" \
  --policy-document file://aws/lambda-execution-policy.json
echo "   policy attached."

echo "==> waiting 10s for IAM role to propagate"
sleep 10

echo "==> 4. Packaging the Lambda"
( cd aws/lambda && zip -q -r ../lambda.zip index.mjs )

echo "==> 5. Creating the Lambda function: $FUNCTION_NAME"
LAMBDA_ENV="Variables={LEADS_TABLE=$TABLE_NAME,BEDROCK_MODEL_ID=amazon.nova-micro-v1:0,MAX_TOKENS=400}"

aws lambda create-function \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --runtime nodejs20.x \
  --handler index.handler \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}" \
  --zip-file fileb://aws/lambda.zip \
  --timeout 30 \
  --environment "$LAMBDA_ENV" \
  2>/dev/null && echo "   created." \
  || ( echo "   exists — updating code + config." && \
       aws lambda update-function-code \
         --region "$REGION" \
         --function-name "$FUNCTION_NAME" \
         --zip-file fileb://aws/lambda.zip >/dev/null && \
       aws lambda update-function-configuration \
         --region "$REGION" \
         --function-name "$FUNCTION_NAME" \
         --timeout 30 \
         --environment "$LAMBDA_ENV" >/dev/null && echo "   code + config updated." )

echo "==> 6. Allowing Lex V2 to invoke the Lambda"
aws lambda add-permission \
  --region "$REGION" \
  --function-name "$FUNCTION_NAME" \
  --statement-id "lex-invoke" \
  --action "lambda:InvokeFunction" \
  --principal "lexv2.amazonaws.com" \
  --source-arn "arn:aws:lex:${REGION}:${ACCOUNT_ID}:bot-alias/*" \
  2>/dev/null && echo "   permission added." || echo "   permission already exists, skipping."

echo ""
echo "Done. Lambda ARN:"
echo "  arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${FUNCTION_NAME}"
echo ""
echo "Next: attach this Lambda to your bot alias + set it as the"
echo "fulfillment code hook on SolicitarServicio. See aws/README.md."
