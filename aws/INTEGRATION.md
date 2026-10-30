# Altiora Estudio — Lex V2 + DynamoDB integration (full reference)

This document explains, end to end, how a visitor's chat message travels from
the browser through Amazon Lex V2 and ends up as a stored lead in DynamoDB.
It covers every component we set up, why each exists, how they connect, the
exact permissions involved, and how to operate and troubleshoot the system.

Audience: a developer (studying the AWS AI Practitioner cert) who wants to
understand the whole pipeline rather than just copy commands.

---

## 1. The big picture

```
┌────────────┐   RecognizeText    ┌────────────┐   fulfillment    ┌────────────┐
│  Browser   │ ─────────────────▶ │  Amazon    │ ───────────────▶ │   Lambda   │
│ (Angular   │  (temp creds from  │  Lex V2    │   code hook      │ fulfillment│
│  chatbot)  │ ◀───────────────── │  bot       │ ◀─────────────── │  function  │
└────────────┘   bot messages     └────────────┘   Close + msg    └─────┬──────┘
      ▲                                                                  │
      │ temporary AWS credentials                                        │ PutItem
      │                                                            ┌─────▼──────┐
┌─────┴───────┐                                                    │  DynamoDB  │
│  Amazon     │                                                    │  table     │
│  Cognito    │                                                    │ (leads)    │
│ Identity Pool│                                                   └────────────┘
└─────────────┘                                                          │
                                                                   (optional) SES email
```

Two independent trust boundaries:

1. **Browser ↔ Lex** — the public SPA holds no AWS secret. It gets short-lived,
   read-only credentials from a Cognito identity pool, scoped so it can *only*
   talk to this one bot alias.
2. **Lex ↔ Lambda ↔ DynamoDB** — all data handling happens server-side. The
   browser never touches DynamoDB. Lex invokes the Lambda, the Lambda writes
   the lead.

Why split like this: the identity pool is *unauthenticated* (anonymous website
visitors). If the browser could write to DynamoDB directly, anyone could pull
the credentials from the bundle and write arbitrary rows. Keeping writes behind
Lex→Lambda means the browser's power is limited to "send a chat message."

---

## 2. Components and identifiers

| Component | Name / ID | Region | Account |
|-----------|-----------|--------|---------|
| Lex V2 bot | id `6COPKGRTBN` | us-east-1 | 229975483756 |
| Bot alias (test) | `TSTALIASID` | us-east-1 | — |
| Locale | `es_419` (Spanish, Latin America) | — | — |
| Intent | `SolicitarServicio` | — | — |
| Cognito identity pool | `us-east-1:17c84447-c827-4ebd-a323-926e44467e46` | us-east-1 | — |
| Unauth IAM role | `Estudio_Nube_Lex_Rolle` | — | — |
| Lambda | `EstudioNubeLeadFulfillment` | us-east-1 | 229975483756 |
| Lambda role | `EstudioNubeLeadLambdaRole` | — | — |
| DynamoDB table | `EstudioNubeLeads` | us-east-1 | 229975483756 |

---

## 3. The conversation (what the bot collects)

The bot has one intent, `SolicitarServicio`, that qualifies a lead by filling
three required slots, in order:

| # | Slot | Type | Prompt (es_419) |
|---|------|------|-----------------|
| 1 | `servicio` | custom `Servicio` | "¿En qué te puedo ayudar? IA en AWS, software a medida, arquitectura en la nube o datos y analítica" |
| 2 | `nombre` | `AMAZON.FirstName` | "¿Cómo te llamas?" |
| 3 | `email` | `AMAZON.EmailAddress` | "¿A qué email podemos contactarte?" |

When all three are filled, the intent is ready for **fulfillment** — that's the
trigger for the Lambda.

---

## 4. Browser → Lex (the frontend)

### 4.1 Packages

```
@aws-sdk/client-lex-runtime-v2                 # the RecognizeText client
@aws-sdk/credential-provider-cognito-identity  # browser-safe Cognito creds
```

We specifically use `@aws-sdk/credential-provider-cognito-identity`, not the
umbrella `@aws-sdk/credential-providers`, because the latter pulls in
Node-only modules (`node:child_process`, `node:fs`, IMDS, SSO) that break the
browser build. The narrow package only contains `fromCognitoIdentityPool`.

### 4.2 The service (`src/app/services/lex.service.ts`)

The client is created once:

```ts
new LexRuntimeV2Client({
  region: 'us-east-1',
  credentials: fromCognitoIdentityPool({
    identityPoolId: 'us-east-1:17c84447-...',
    clientConfig: { region: 'us-east-1' },
  }),
});
```

`fromCognitoIdentityPool` handles the whole credential handshake transparently:

1. Calls `cognito-identity:GetId` to get an identity id for this anonymous
   visitor.
2. Calls `cognito-identity:GetCredentialsForIdentity` to exchange that id for
   temporary AWS credentials (an assumed-role session on
   `Estudio_Nube_Lex_Rolle`).
3. Signs the subsequent Lex request (SigV4) with those temporary credentials.
4. Caches and refreshes them automatically.

Each app load gets a fresh `sessionId` (`crypto.randomUUID()`), which keeps a
visitor's conversation turns tied together server-side while separating one
visitor from another.

Sending a message:

```ts
await client.send(new RecognizeTextCommand({
  botId:      '6COPKGRTBN',
  botAliasId: 'TSTALIASID',
  localeId:   'es_419',
  sessionId,
  text,
}));
```

### 4.3 Reading the reply

From the response the service extracts:

- `messages[]` → the bot's text (and any button cards) to render in the UI.
- `sessionState.intent.state` → when it is `Fulfilled` / `ReadyForFulfillment`,
  the lead is complete.
- `sessionState.intent.slots[name].value.interpretedValue` → the captured
  `nombre`, `email`, `servicio`, which the UI shows in the "Datos registrados"
  card.

The frontend does **not** persist anything — storage is server-side. The lead
card is just a courtesy confirmation to the user.

---

## 5. Cognito + IAM (how the browser is trusted)

### 5.1 The identity pool

Created as an **unauthenticated** identity pool (guest access enabled, no login
providers). Creating it auto-generated an unauthenticated IAM role. In our case
that role is `Estudio_Nube_Lex_Rolle`.

The pool's built-in policy already grants the two Cognito calls the SDK needs
(`GetId`, `GetCredentialsForIdentity`), so we didn't add those manually.

### 5.2 The runtime permission (the fix that made the chat work)

The unauthenticated role needs explicit permission to call the Lex runtime.
Initially it had none, which produced:

> `User: ...assumed-role/Estudio_Nube_Lex_Rolle/CognitoIdentityCredentials is
> not authorized to perform: lex:RecognizeText ... because no identity-based
> policy allows the lex:RecognizeText action`

We attached this inline policy to `Estudio_Nube_Lex_Rolle`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lexv2-runtime:RecognizeText",
        "lexv2-runtime:RecognizeUtterance",
        "lexv2-runtime:DeleteSession",
        "lexv2-runtime:GetSession",
        "lexv2-runtime:PutSession"
      ],
      "Resource": "arn:aws:lex:us-east-1:229975483756:bot-alias/6COPKGRTBN/TSTALIASID"
    }
  ]
}
```

Key detail: the `Resource` is scoped to the **specific bot alias** ARN
(`bot-alias/<botId>/<aliasId>`). The browser can hit this one alias and nothing
else. This is the whole security posture of the public chat.

> Note: the IAM action prefix is `lexv2-runtime:` for V2 runtime calls. The
> error message above abbreviates it as `lex:RecognizeText`; both refer to the
> same V2 runtime operation.

---

## 6. Lex → Lambda (the fulfillment hook)

### 6.1 What a "fulfillment code hook" is

Each Lex intent can call a Lambda at two points: the *dialog* code hook (during
slot collection) and the *fulfillment* code hook (once all slots are filled).
We use only the **fulfillment** hook on `SolicitarServicio`. Lex invokes the
Lambda exactly once, when the lead is complete — ideal for a single write.

### 6.2 Wiring (two required switches)

Lex only calls the Lambda when **both** are set:

1. **Alias level** — the `TestBotAlias` (behind `TSTALIASID`), for the Spanish
   language, has its **Lambda function** set to `EstudioNubeLeadFulfillment`.
2. **Intent level** — `SolicitarServicio` → Fulfillment → "Use a Lambda
   function for fulfillment" is enabled.

Then the bot is **rebuilt**. Miss either switch and the Lambda never fires.

### 6.3 Permission for Lex to invoke the Lambda

A resource-based permission on the Lambda allows the Lex service principal to
invoke it (added by `setup.sh`):

```
aws lambda add-permission \
  --function-name EstudioNubeLeadFulfillment \
  --statement-id lex-invoke \
  --action lambda:InvokeFunction \
  --principal lexv2.amazonaws.com \
  --source-arn "arn:aws:lex:us-east-1:229975483756:bot-alias/*"
```

Without this, Lex's invoke attempt is denied and the conversation errors at
fulfillment.

### 6.4 The event Lex sends

Lex posts a JSON event whose relevant shape is:

```json
{
  "sessionId": "…",
  "bot": { "localeId": "es_419", "id": "6COPKGRTBN" },
  "sessionState": {
    "intent": {
      "name": "SolicitarServicio",
      "state": "ReadyForFulfillment",
      "slots": {
        "servicio": { "value": { "interpretedValue": "IA en AWS", "originalValue": "ia" } },
        "nombre":   { "value": { "interpretedValue": "Ana" } },
        "email":    { "value": { "interpretedValue": "ana@acme.com" } }
      }
    }
  }
}
```

The Lambda's `slotValue()` helper reads
`slots[name].value.interpretedValue` (falling back to `originalValue`), exactly
mirroring how the frontend reads slots.

---

## 7. The Lambda (`aws/lambda/index.mjs`)

Node.js 20 runtime, ESM, no bundled dependencies — it uses the AWS SDK v3 that
ships inside the Lambda Node 18+ runtime. Three responsibilities:

### 7.1 Build the lead record

```js
const lead = {
  id: `${Date.now()}-${random}`,   // partition key — unique per inquiry
  createdAt: new Date().toISOString(),
  nombre, email, servicio,          // from the slots
  intent, sessionId, locale,        // provenance
};
```

### 7.2 Write to DynamoDB

```js
await ddb.send(new PutCommand({ TableName: 'EstudioNubeLeads', Item: lead }));
```

`DynamoDBDocumentClient` lets us pass a plain JS object instead of DynamoDB's
typed attribute format. The write is wrapped in try/catch so a storage hiccup
never breaks the user's conversation — we log and continue.

### 7.3 Optionally email via SES

If `SES_FROM` and `SES_TO` env vars are present, it sends a plain-text summary.
If they're absent, the SES client is never created and the step is skipped.

### 7.4 Respond to Lex

```js
return {
  sessionState: {
    dialogAction: { type: 'Close' },
    intent: { name: intentName, state: 'Fulfilled' },
  },
  messages: [{ contentType: 'PlainText', content: '¡Gracias, Ana! …' }],
};
```

`dialogAction.type: "Close"` ends the conversation. The `messages` here
*override* the intent's static closing message, letting us personalise it with
the captured name/email/service. Because the response still carries the
fulfilled intent + slots, the frontend's lead card continues to work unchanged.

---

## 8. The DynamoDB table

Created with on-demand (pay-per-request) billing and a single partition key:

```
Table:      EstudioNubeLeads
Key schema: id (String, HASH / partition key)
Billing:    PAY_PER_REQUEST
```

On-demand billing means no capacity planning and near-zero cost at low volume.
The schema is intentionally minimal — DynamoDB is schemaless beyond the key, so
each item just carries whatever attributes the Lambda writes.

Item example:

```json
{
  "id": "1739980800000-k3j9x1qp",
  "createdAt": "2026-10-20T04:00:00.000Z",
  "nombre": "Ana",
  "email": "ana@acme.com",
  "servicio": "IA en AWS",
  "intent": "SolicitarServicio",
  "sessionId": "…",
  "locale": "es_419"
}
```

---

## 9. The Lambda execution role

`EstudioNubeLeadLambdaRole` trusts the Lambda service
(`lambda.amazonaws.com`) and carries this least-privilege inline policy
(`aws/lambda-execution-policy.json`):

| Statement | Allows | Scope |
|-----------|--------|-------|
| WriteLeads | `dynamodb:PutItem` | the `EstudioNubeLeads` table ARN only |
| SendLeadEmail | `ses:SendEmail` | `*` (SES identities are controlled by verification, not ARN) |
| Logs | `logs:CreateLogGroup/Stream`, `logs:PutLogEvents` | account logs |

The Lambda can write leads, send mail, and log — nothing else. It cannot read
or delete items, nor touch any other table.

---

## 10. Provisioning script (`aws/setup.sh`)

One command provisions the server side:

```bash
bash aws/setup.sh
```

Steps it performs, in order:

1. `dynamodb create-table` → `EstudioNubeLeads`, then waits for ACTIVE.
2. `iam create-role` → `EstudioNubeLeadLambdaRole` with a Lambda trust policy.
3. `iam put-role-policy` → attaches the least-privilege policy above.
4. Waits ~10s for IAM propagation (new roles aren't instantly usable).
5. Zips `aws/lambda/index.mjs` and `lambda create-function` (or updates code if
   it already exists).
6. `lambda add-permission` → lets `lexv2.amazonaws.com` invoke it.

It's idempotent: re-running updates the function code instead of failing on
"already exists."

The console-only steps that remain (attaching the Lambda to the alias + intent,
then Build) are in `aws/README.md` — those are simpler to do in the Lex console
than via CLI.

---

## 11. End-to-end walkthrough of one lead

1. Visitor opens the site; the hero chat is live.
2. Visitor types "hola". Browser requests temp creds from Cognito, signs a
   `RecognizeText` call to alias `TSTALIASID`, sends the text.
3. Lex matches `SolicitarServicio`, prompts for `servicio`, then `nombre`, then
   `email`, turn by turn. Each turn is another `RecognizeText` round-trip.
4. After the third slot, the intent is `ReadyForFulfillment`. Lex invokes
   `EstudioNubeLeadFulfillment` with the event in §6.4.
5. The Lambda writes the lead to DynamoDB, optionally emails it, and returns a
   `Close` dialog with a personalised goodbye.
6. Lex sends that goodbye back to the browser. The frontend shows the message
   and the "Datos registrados" card.
7. The row is now queryable in DynamoDB.

---

## 12. Operating & troubleshooting

### View leads

```bash
aws dynamodb scan --region us-east-1 --table-name EstudioNubeLeads \
  --filter-expression "attribute_not_exists(kind)" \
  --query "Items[].{nombre:nombre.S,email:email.S,servicio:servicio.S,createdAt:createdAt.S}" \
  --output table
```

### Read Lambda logs

```bash
aws logs tail /aws/lambda/EstudioNubeLeadFulfillment --follow --region us-east-1
```

The Lambda logs the full Lex event and a "Lead saved" / error line per call.

### Common failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `not authorized to perform: lex:RecognizeText` in the chat | Unauth role missing the Lex runtime policy | Attach the policy in §5.2 |
| Chat works but no row in DynamoDB | Lambda not wired to alias+intent, or bot not rebuilt | Do both switches in §6.2, then Build |
| Lambda runs but `PutItem` denied in logs | Execution role missing DynamoDB permission or wrong table ARN | Check `aws/lambda-execution-policy.json` |
| Lex can't invoke Lambda | Missing `add-permission` for `lexv2.amazonaws.com` | Re-run step 6 of `setup.sh` |
| No email arrives | `SES_FROM`/`SES_TO` unset, or SES sandbox hasn't verified the recipient | See §4 of `aws/README.md` |
| `ValidationException` from `RecognizeText` | `localeId` mismatch (bot built as `es_ES`, app sends `es_419`) | Align `localeId` in `lex.service.ts` |

### Cost

At low volume everything sits within or near the AWS Free Tier: DynamoDB
on-demand (pay per request), Lambda (1M free requests/month), SES (62k
free/month when sent from Lambda).

---

## 13. Hardening — status

### Done

- **Config out of source** — `region`, `identityPoolId`, `botId`, `botAliasId`,
  `localeId` now live in `src/environments/environment.ts` (and
  `environment.prod.ts`). `lex.service.ts` reads `environment.lex`. A production
  build swaps in `environment.prod.ts` via `fileReplacements` in `angular.json`.
- **Email validation** — the fulfillment Lambda checks the email with a
  pragmatic regex; a malformed value triggers an `ElicitSlot` response so Lex
  re-asks instead of saving junk. See `isValidEmail()` in `aws/lambda/index.mjs`.
- **Rate limiting / dedup** — the Lambda writes a short-lived guard item keyed
  by `rl#<email>` with a `ConditionExpression`, so the same email can't submit
  more than once per `RATE_LIMIT_WINDOW_SECONDS` (120s). The guard carries a
  DynamoDB TTL on the `ttl` attribute (enabled by `aws/setup.sh`). See
  `passesRateLimit()`.

### Still to consider

- **Production alias** — `TSTALIASID` runs against the DRAFT version. For
  production, publish a bot version, create a dedicated alias, point
  `environment.prod.ts` `botAliasId` at it, and update the IAM `Resource` ARN on
  the Cognito unauth role to the new alias.
- **Conversation logs** — enable Lex conversation logs (to CloudWatch/S3) for
  auditing beyond the fulfilled-lead rows.
- **Browsing leads** — for now, read leads with `aws dynamodb scan` or the
  DynamoDB console (§12). A dashboard can come later if volume warrants it.

> Note on the leads table: rate-limit guard items (`id` starting with `rl#`,
> `kind: "ratelimit"`) share the table with real leads. When reading leads,
> filter them out — e.g. add
> `--filter-expression "attribute_not_exists(kind)"` to the scan.
