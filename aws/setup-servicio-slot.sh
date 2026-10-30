#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Altiora Estudio — create the custom "Servicio" slot type and point the
# SolicitarServicio `servicio` slot at it (TopResolution), so the slot only
# accepts the four real services (+ synonyms) and rejects junk like "hola".
#
# Re-run if the bot/locale is recreated. Rebuilds the locale at the end.
# Run from anywhere:  bash aws/setup-servicio-slot.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="us-east-1"
BOT_ID="6COPKGRTBN"
BOT_VERSION="DRAFT"
LOCALE_ID="es_419"
INTENT_ID="DHRYSO6HGI"      # SolicitarServicio
SLOT_ID="WCDVFKBDCG"        # servicio slot

VALUES='[
  {"sampleValue":{"value":"IA en AWS"},"synonyms":[{"value":"inteligencia artificial"},{"value":"IA"},{"value":"chatbot"},{"value":"chatbots"},{"value":"lex"},{"value":"bedrock"},{"value":"asistente"},{"value":"voz"},{"value":"vision"}]},
  {"sampleValue":{"value":"Software a medida"},"synonyms":[{"value":"software"},{"value":"desarrollo"},{"value":"app"},{"value":"aplicacion"},{"value":"aplicación"},{"value":"aplicacion web"},{"value":"web"},{"value":"pagina web"},{"value":"página web"},{"value":"sitio web"},{"value":"landing"},{"value":"landing page"}]},
  {"sampleValue":{"value":"Arquitectura en la nube"},"synonyms":[{"value":"nube"},{"value":"cloud"},{"value":"aws"},{"value":"infraestructura"},{"value":"migracion"},{"value":"migración"},{"value":"servidores"}]},
  {"sampleValue":{"value":"Datos y analítica"},"synonyms":[{"value":"datos"},{"value":"analitica"},{"value":"analítica"},{"value":"dashboard"},{"value":"tablero"},{"value":"reportes"},{"value":"bi"}]}
]'

ELICIT='{
  "slotConstraint":"Required",
  "promptSpecification":{
    "messageGroups":[{"message":{"plainTextMessage":{"value":"¿Qué servicio te interesa? Puedes elegir: IA en AWS, software a medida, arquitectura en la nube o datos y analítica."}}}],
    "maxRetries":2,"allowInterrupt":true,"messageSelectionStrategy":"Random"
  },
  "slotCaptureSetting":{
    "captureNextStep":{"dialogAction":{"type":"ElicitSlot","slotToElicit":"nombre"},"intent":{}},
    "failureNextStep":{"dialogAction":{"type":"StartIntent"},"intent":{"name":"FallbackIntent"}},
    "elicitationCodeHook":{"enableCodeHookInvocation":true}
  }
}'

echo "==> Looking up existing Servicio slot type"
SLOT_TYPE_ID=$(aws lexv2-models list-slot-types --bot-id "$BOT_ID" --bot-version "$BOT_VERSION" \
  --locale-id "$LOCALE_ID" --region "$REGION" \
  --query "slotTypeSummaries[?slotTypeName=='Servicio'].slotTypeId | [0]" --output text)

if [ "$SLOT_TYPE_ID" = "None" ] || [ -z "$SLOT_TYPE_ID" ]; then
  echo "==> Creating Servicio slot type"
  SLOT_TYPE_ID=$(aws lexv2-models create-slot-type \
    --bot-id "$BOT_ID" --bot-version "$BOT_VERSION" --locale-id "$LOCALE_ID" \
    --slot-type-name "Servicio" \
    --slot-type-values "$VALUES" \
    --value-selection-setting '{"resolutionStrategy":"TopResolution"}' \
    --region "$REGION" --query "slotTypeId" --output text)
  echo "   created: $SLOT_TYPE_ID"
else
  echo "   exists: $SLOT_TYPE_ID (reusing)"
fi

echo "==> Pointing the servicio slot at the custom type"
aws lexv2-models update-slot \
  --bot-id "$BOT_ID" --bot-version "$BOT_VERSION" --locale-id "$LOCALE_ID" --intent-id "$INTENT_ID" \
  --slot-id "$SLOT_ID" --slot-name servicio --slot-type-id "$SLOT_TYPE_ID" \
  --value-elicitation-setting "$ELICIT" \
  --region "$REGION" --query "{name:slotName,type:slotTypeId}" --output json

echo "==> Rebuilding the $LOCALE_ID locale"
aws lexv2-models build-bot-locale \
  --bot-id "$BOT_ID" --bot-version "$BOT_VERSION" --locale-id "$LOCALE_ID" \
  --region "$REGION" --query "botLocaleStatus" --output text

echo ""
echo "Build started. Wait until 'Built', then test."
