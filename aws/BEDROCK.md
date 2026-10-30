# Altiora Estudio — Bedrock generative answers (Alti)

The chatbot's assistant "Alti" answers free-form questions using **Amazon
Bedrock** (Nova Micro). Because a Lex alias routes every code-hook intent to a
**single Lambda per language**, the Bedrock logic lives in the **same Lambda**
as the lead capture (`EstudioNubeLeadFulfillment`). It branches on the intent:

```
Visitor ─▶ Lex ─▶ EstudioNubeLeadFulfillment (one Lambda)
                    ├─ intent = SolicitarServicio → save lead to DynamoDB
                    └─ intent = FallbackIntent     → ask Bedrock (Nova Micro)
                                                      (FAQ is in the system prompt)
```

No knowledge base, no vector store → **zero standing cost**. You pay only per
Bedrock call (fractions of a cent with Nova Micro).

---

## Prerequisites — this is NOT the full setup

This guide only covers **adding Bedrock answers** on top of an already-working
bot. It assumes the foundation from the earlier docs is in place:

| Doc | What it covers | Read it if… |
|-----|----------------|-------------|
| **`INTEGRATION.md`** | Full architecture: Cognito identity pool, IAM runtime role, the Lex bot + `SolicitarServicio` intent, the lead Lambda, DynamoDB. | …you're setting up from scratch. **Start here.** |
| **`README.md`** | Provisioning quick-start: `setup.sh`, wiring the Lambda to the alias, SES email, TTL. | …you're ready to run the commands. |
| **`BEDROCK.md`** (this file) | The generative-answers addition only. | …the bot already works and you want Alti to answer free-form questions. |

**Recommended order for a full AWS setup:** INTEGRATION.md → README.md →
BEDROCK.md.

Specifically, before following this guide you should already have:
- The Lex bot built, with `SolicitarServicio` and the lead flow working.
- The `EstudioNubeLeadFulfillment` Lambda deployed and attached to the bot alias
  (`TestBotAlias`).
- The Cognito identity pool + IAM runtime role (so the browser can reach Lex).

If all that is done, continue below.

---

## Why not AMAZON.QnAIntent

QnAIntent is the no-code path, **but it requires a knowledge store** (Bedrock
Knowledge Base, OpenSearch, or Kendra) — there is no "model-only" option, and
OpenSearch Serverless costs $350–700/month at zero traffic. Calling Bedrock's
Converse API from our own Lambda, with the one-page FAQ in the system prompt,
avoids all of that and gives a hard server-side token cap.

---

## Cost

- **Lambda:** 1M free requests/month → effectively $0 at chat volume.
- **Bedrock Nova Micro:** ~$0.035/1M input, ~$0.14/1M output ≈ **$0.00006 per
  answer** (~1,600 answers per US$0.10).
- **Vector store:** none — **$0 standing cost.**
- Bounded further by the client-side 15-messages/session cap.

---

## Guardrails

1. **Output tokens (hard):** `MAX_TOKENS` env var on the Lambda (default 400),
   passed to Converse as `inferenceConfig.maxTokens`.
2. **Per-session cap:** Angular `ChatStateService` — 15 messages/session, 300
   chars each, then points the visitor to email. Edit the constants at the top
   of `src/app/services/chat-state.service.ts`.
3. **System prompt:** keeps answers short, Spanish, on-topic; refuses to confirm
   final prices or answer off-topic questions.

---

## How it's wired (the one-Lambda rule)

A Lex alias uses **one Lambda per language**, and sends every code-hook intent
to it. Your `TestBotAlias` already points at `EstudioNubeLeadFulfillment`, so we
merged the Bedrock behaviour into that function rather than adding a second one.
`aws/lambda/index.mjs` now:

- `intent === 'FallbackIntent'` → `answerWithBedrock()` (Converse → Nova Micro).
- otherwise → the existing lead-capture flow (validation, rate limit, DynamoDB,
  SES).

The `SYSTEM_PROMPT` constant in that file carries the FAQ. Keep it in sync with
`aws/knowledge-base/alti-system-prompt.txt` (the readable source of truth).

---

## Setup

### 1. Enable Bedrock model access
Console → **Amazon Bedrock → Model access → Modify model access**. Enable
**Amazon Nova Micro** (optionally Nova Lite) in **us-east-1**. The Lambda can't
invoke a model you don't have access to.

### 2. Deploy the merged Lambda + updated policy
From the project root:

```bash
bash aws/setup.sh
```

This now also:
- adds `bedrock:InvokeModel` (Nova Micro/Lite) to the Lambda's role policy
  (`lambda-execution-policy.json`),
- updates the Lambda code,
- sets env vars `BEDROCK_MODEL_ID=amazon.nova-micro-v1:0`, `MAX_TOKENS=400`,
- raises the timeout to 30s (Bedrock calls take a few seconds).

> `setup.sh` is idempotent — since the Lambda already exists, it updates the
> code **and** configuration (timeout + env vars), and re-applies the policy.

### 3. Activate the FallbackIntent code hook

The alias already points at the Lambda, so you only need the FallbackIntent to
actually invoke it. **The reliable way is the script:**

```bash
bash aws/fix-fallback-hook.sh
```

It sets the fulfillment hook to `enabled:true, active:true`, disables the dialog
hook, removes the static initial response, and rebuilds the locale. Wait until
the build status reads `Built`, then test.

> **Why a script and not just the console toggle — the Lex V2 gotcha:** a code
> hook has TWO flags, `enabled` (it exists) and `active` (Lex actually calls
> it). The console frequently leaves a FallbackIntent at `enabled:true /
> active:false`, AND adds a static `initialResponse` (the "¿Perdón, no te
> entendí?" message) whose next step points at a *disabled* dialog hook. The
> result: Lex shows the static message and never calls the Lambda. The script
> forces `active:true` and strips the static response so the fallback flows
> straight to Bedrock.

If you prefer the console: FallbackIntent → **Fulfillment** → expand **Advanced
options** → ensure the Lambda hook is both enabled *and* active, remove the
initial response, then **Build**. The script is less error-prone.

Also: if you created an `AMAZON.QnAIntent` earlier, **delete it** (not needed).

### 4. Test
Ask free-form questions on the site:

- "¿cuánto cuesta una landing page?" → ~$12,000 MXN.
- "¿hacen apps web?" → describes the service.
- "¿cuál es la capital de Francia?" → politely declines, steers back.

And confirm the lead flow still works (service → name → email → saved).

Logs:

```bash
aws logs tail /aws/lambda/EstudioNubeLeadFulfillment --follow --region us-east-1
```

---

## Tuning: how much goes to Bedrock vs. the lead flow

Lex decides between a real intent (like `SolicitarServicio`) and the
`FallbackIntent` using an **intent confidence threshold** (default **0.40**).
If NLU's confidence for every intent is below the threshold, the utterance
falls through to `FallbackIntent` → your Lambda → Bedrock.

- **Too many messages going to Bedrock** (even clear lead phrases get a generic
  answer instead of starting the form): the threshold is too high, or the
  `SolicitarServicio` sample utterances are too sparse. **Lower** the threshold
  (e.g. 0.30) and/or add more sample utterances to the intent.
- **The lead form triggers when people are just chatting** (Lex forces the
  service/name/email flow on casual questions): the threshold is too low.
  **Raise** it (e.g. 0.50) so more unmatched chat reaches Bedrock.

Where to change it:

- **Console:** Lex → your bot → Spanish (es_419) → **Language details** (or the
  intent-classification settings for the locale) → **Confidence score
  threshold** → adjust → **Build**.
- **CLI:** it's the `nluIntentConfidenceThreshold` on the locale
  (`update-bot-locale`).

Guidance for this bot: start at the default **0.40**. If free-form questions
feel like they're being shoved into the lead form, nudge up to 0.45–0.50; if
genuine "quiero una landing page" messages don't start the lead flow, add
sample utterances to `SolicitarServicio` before lowering the threshold — more
examples fix classification more reliably than a lower threshold, which can let
noise through.

> Note: the threshold does not affect slot-elicitation turns. While Lex is
> collecting `servicio`/`nombre`/`email`, an unrecognized answer is re-prompted
> for that slot — it does not fall through to Bedrock.

---

## Updating Alti's knowledge
Edit the `SYSTEM_PROMPT` in `aws/lambda/index.mjs` (and the matching
`alti-system-prompt.txt`), then re-run `bash aws/setup.sh`. No bot rebuild
needed for prompt-only changes.

## Switching models
Change the env var (no code change):

```bash
aws lambda update-function-configuration --region us-east-1 \
  --function-name EstudioNubeLeadFulfillment \
  --environment "Variables={LEADS_TABLE=EstudioNubeLeads,BEDROCK_MODEL_ID=amazon.nova-lite-v1:0,MAX_TOKENS=400}"
```

For a non-Nova model, add its ARN to `lambda-execution-policy.json` and re-run
`setup.sh`. (Note: `update-function-configuration` replaces all env vars, so
include `LEADS_TABLE` as shown.)
