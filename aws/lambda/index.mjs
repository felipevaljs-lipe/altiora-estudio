// ---------------------------------------------------------------------------
// Altiora Estudio — Lex V2 fulfillment Lambda
//
// Attached to the `SolicitarServicio` intent as the fulfillmentCodeHook.
// Amazon Lex V2 invokes this once the intent is ready to be fulfilled
// (all slots filled). It persists the lead to DynamoDB, optionally emails
// the team via SES, then returns a Close dialog so Lex speaks the goodbye
// message to the user.
//
// Runtime: Node.js 20.x (ESM). Zero external deps — uses the AWS SDK v3
// that is bundled into the Lambda Node.js 18+ runtime.
// ---------------------------------------------------------------------------

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE_NAME = process.env.LEADS_TABLE || 'EstudioNubeLeads';

// Optional email notification. Leave SES_* env vars unset to skip emailing.
const SES_FROM = process.env.SES_FROM;       // verified SES sender, e.g. hola@altioraestudio.com
const SES_TO = process.env.SES_TO;           // where leads should land

// Bedrock generative answers (FallbackIntent). Model + token cap via env vars.
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.nova-micro-v1:0';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 400);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ses = SES_FROM && SES_TO ? new SESClient({ region: REGION }) : null;
const bedrock = new BedrockRuntimeClient({ region: REGION });

/**
 * Read a slot's interpreted (or original) value from the Lex event.
 */
function slotValue(slots, name) {
  const slot = slots?.[name];
  return slot?.value?.interpretedValue ?? slot?.value?.originalValue ?? null;
}

export const handler = async (event) => {
  console.log('Lex event:', JSON.stringify(event));

  const intent = event.sessionState?.intent;
  const intentName = intent?.name ?? 'Desconocido';

  // Route: unmatched questions (FallbackIntent) → Bedrock generative answer.
  // Everything else falls through to the lead-capture flow below.
  if (intentName === 'FallbackIntent') {
    return answerWithBedrock(event, intentName);
  }

  const slots = intent?.slots ?? {};

  const nombreVal = slotValue(slots, 'nombre');
  const emailVal = slotValue(slots, 'email');
  const servicioVal = slotValue(slots, 'servicio');

  // --- Validation: email format -------------------------------------------
  // If the email is present but malformed, re-elicit the `email` slot so Lex
  // asks the user again instead of saving a junk lead.
  if (emailVal && !isValidEmail(emailVal)) {
    console.log('Invalid email, re-eliciting:', emailVal);
    return elicitSlot(intentName, slots, 'email',
      'Mmm, ese email no parece válido. ¿Me lo escribes de nuevo? (ej. nombre@dominio.com)');
  }

  // --- Rate limit / dedup --------------------------------------------------
  // Reject a repeat submission from the same email within the cooldown window.
  // Uses a conditional write on a guard item with a DynamoDB TTL.
  if (emailVal) {
    const allowed = await passesRateLimit(emailVal);
    if (!allowed) {
      console.log('Rate limited:', emailVal);
      return close(intentName,
        'Ya recibimos tu solicitud hace un momento. ¡Gracias! Te contactaremos pronto. ☁️');
    }
  }

  const lead = {
    // Partition key: a unique id per inquiry
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    nombre: nombreVal,
    email: emailVal,
    servicio: servicioVal,
    intent: intentName,
    sessionId: event.sessionId ?? null,
    locale: event.bot?.localeId ?? null,
  };

  // 1) Persist to DynamoDB
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: lead,
      }),
    );
    console.log('Lead saved:', lead.id);
  } catch (err) {
    // Don't fail the conversation if storage hiccups — log and continue.
    console.error('DynamoDB put failed:', err);
  }

  // 2) Optional email notification via SES
  if (ses) {
    try {
      await ses.send(
        new SendEmailCommand({
          Source: SES_FROM,
          Destination: { ToAddresses: [SES_TO] },
          Message: {
            Subject: { Data: `Nuevo lead: ${lead.servicio ?? 'Consulta'} — ${lead.nombre ?? ''}` },
            Body: {
              Text: {
                Data: [
                  'Nuevo lead desde el chatbot Nube',
                  '',
                  `Nombre:   ${lead.nombre ?? '-'}`,
                  `Email:    ${lead.email ?? '-'}`,
                  `Servicio: ${lead.servicio ?? '-'}`,
                  `Fecha:    ${lead.createdAt}`,
                  `Sesión:   ${lead.sessionId ?? '-'}`,
                ].join('\n'),
              },
            },
          },
        }),
      );
      console.log('Lead email sent to', SES_TO);
    } catch (err) {
      console.error('SES send failed:', err);
    }
  }

  // 3) Tell Lex the intent is fulfilled and close the conversation.
  //    The content here overrides the intent's closing message, so we can
  //    personalise it with the captured slots.
  const nombre = lead.nombre ? `, ${lead.nombre}` : '';
  const message =
    `¡Gracias${nombre}! Registramos tu interés en ${lead.servicio ?? 'nuestros servicios'}. ` +
    `Te escribiremos pronto a ${lead.email ?? 'tu correo'}. ☁️`;

  return close(intentName, message);
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Pragmatic email check — not RFC-perfect, but rejects the obvious junk:
 * requires `local@domain.tld` with no spaces and a 2+ char TLD.
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

// ---------------------------------------------------------------------------
// Rate limiting / dedup
//
// Writes a short-lived guard item keyed by `rl#<email>` with a conditional
// expression so a second submission from the same email inside the cooldown
// window fails the write (ConditionalCheckFailed) → we treat that as "rate
// limited". The guard item carries a DynamoDB TTL so it auto-expires; enable
// TTL on the `ttl` attribute of the table (see aws/README.md).
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_SECONDS = 120; // one lead per email per 2 minutes

async function passesRateLimit(email) {
  const now = Math.floor(Date.now() / 1000);
  const key = `rl#${String(email).trim().toLowerCase()}`;
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          id: key,
          ttl: now + RATE_LIMIT_WINDOW_SECONDS,
          createdAt: new Date().toISOString(),
          kind: 'ratelimit',
        },
        // Only succeeds if no live guard exists for this email.
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
    return true; // no guard existed → allowed
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return false; // guard still live → throttle
    }
    // On any other error, fail open (don't block a legit lead over infra noise).
    console.error('Rate-limit check error (failing open):', err);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Bedrock generative answer (FallbackIntent)
//
// For questions that don't match a structured intent, ask Amazon Bedrock
// (Nova Micro) to answer, grounded by a system prompt that carries the Altiora
// Estudio FAQ. No knowledge base / vector store → zero standing cost.
// Keep SYSTEM_PROMPT in sync with aws/knowledge-base/alti-system-prompt.txt.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Eres "Alti", el asistente virtual de Altiora Estudio. Respondes en español, de forma breve, clara y amable (máximo 3-4 frases). Solo hablas de Altiora Estudio y sus servicios; si te preguntan otra cosa, declina con cortesía e invita a volver al tema o a dejar sus datos.

SOBRE ALTIORA ESTUDIO
Somos un estudio de software e inteligencia artificial. Diseñamos y construimos soluciones a la medida: chatbots con IA, aplicaciones web y móviles, landing pages y sitios, APIs e integraciones, y arquitectura en la nube con AWS. Combinamos diseño cuidado con ingeniería sólida, trabajamos por entregas cortas (sprints) y acompañamos la solución tras el lanzamiento. Atendemos de forma remota a clientes en México y Latinoamérica, en español e inglés.

SERVICIOS
- IA en AWS: chatbots/asistentes (Amazon Lex + Bedrock), voz (Polly), transcripción (Transcribe), visión (Rekognition), análisis de texto (Comprehend) e IA generativa (Bedrock).
- Desarrollo de software a medida (web y móvil).
- Landing pages y sitios rápidos, bien diseñados y optimizados.
- APIs e integraciones entre sistemas, datos y herramientas.
- Arquitectura en la nube (AWS): infraestructura escalable y segura.
- Datos y analítica: tableros e indicadores accionables.

PRECIOS (referenciales, en MXN + IVA; el precio final depende del alcance y se confirma en una propuesta formal)
- Landing page: desde $12,000 MXN.
- Sitio web: desde $25,000 MXN.
- Aplicación web a medida (MVP): desde $80,000 MXN.
- Chatbot con IA: desde $35,000 MXN (un canal, web).
- Integración o API: desde $20,000 MXN por integración.
- Evaluación de arquitectura/migración en la nube: desde $18,000 MXN.
- Soporte y mantenimiento opcional: desde $4,000 MXN al mes. El hosting y los servicios de AWS se facturan aparte según el consumo real.
- Forma de pago habitual: 50% de anticipo y el resto contra entregas.

PROCESO Y TIEMPOS
Trabajamos en 4 etapas: Descubrimiento, Diseño, Desarrollo (en sprints) y Lanzamiento. Tiempos estimados: landing 1-2 semanas; sitio 2-4 semanas; MVP de app o chatbot 4-8 semanas, según alcance. La fecha exacta se define en la cotización.

CONTACTO
Por el chat de este sitio o por correo a hola@altioraestudio.com. Para cotizar ayuda saber: qué quieres construir, para qué, si hay algo existente o referencias, y tu fecha ideal.

REGLAS IMPORTANTES
- Los precios son referenciales y en MXN. Nunca confirmes un precio final ni cierres un trato: da el rango y menciona que hay una propuesta formal.
- No inventes servicios, cifras ni plazos que no estén aquí. Si no sabes algo, dilo y ofrece contactar al equipo.
- Si la pregunta no es sobre Altiora Estudio, responde con amabilidad que solo puedes ayudar con temas de Altiora Estudio.
- IMPORTANTE: responde SOLO la pregunta. No pidas los datos de contacto ni ofrezcas una propuesta tú mismo; de eso se encarga el sistema después de tu respuesta. No agregues despedidas.`;

// ---------------------------------------------------------------------------
// Conversation flow (the "tree")
//
// Alti answers questions with Bedrock (conversation-first). After the visitor
// has engaged a little, Alti SOFTLY offers to prepare a proposal. We track the
// soft-sell state in a Lex session attribute `offerStage`:
//
//   (none)        → first turns: answer + count engagement
//   "offered"     → Alti has made the soft proposal offer; next reply is judged
//   "declined"    → visitor said no; Alti made one email-only ask
//
// Branches after an offer:
//   affirmative  → hand off to SolicitarServicio (elicit servicio) → full lead
//   negative     → gracious + one soft email-only ask (offerStage=declined)
//   another Q    → Bedrock answers again, stays conversational
//
// On the "declined" turn: an email → save partial lead; otherwise warm sign-off.
// ---------------------------------------------------------------------------

// Simple intent detection on short replies (es). Deliberately conservative.
const AFFIRMATIVE_RE =
  /\b(s[ií]|sip|claro|va|dale|de acuerdo|ok|okay|órale|orale|dalee|me interesa|dame|dámela|damela|dame la|quiero(?!\s+saber)|dale pues|dale va|dalee|perfecto|dale ahí|hazlo|dalee)\b/i;
const NEGATIVE_RE =
  /\b(no|ahora no|despu[eé]s|luego|solo (estaba )?viendo|sólo (estaba )?viendo|no gracias|nel|paso|todav[ií]a no|aun no|a[uú]n no)\b/i;

function getOfferStage(event) {
  return event.sessionState?.sessionAttributes?.offerStage ?? 'none';
}

function sessionAttrs(event, extra = {}) {
  return { ...(event.sessionState?.sessionAttributes ?? {}), ...extra };
}

/** Extract an email from free text, if present. */
function extractEmail(text) {
  const m = String(text).match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
  return m ? m[0] : null;
}

/**
 * Best-effort: map a free-form question to one of the four canonical service
 * values, so we can pre-fill the `servicio` slot and skip asking for it.
 * Returns a canonical value or null. Order matters — more specific first.
 */
function detectService(text) {
  const t = String(text).toLowerCase();
  if (/\b(landing|p[aá]gina web|pagina web|sitio web|sitio|web(site)?|app|aplicaci[oó]n|software|desarrollo|m[oó]vil|movil)\b/.test(t)) {
    return 'Software a medida';
  }
  if (/\b(chatbot|chat bot|asistente|ia|inteligencia artificial|lex|bedrock|voz|visi[oó]n|vision)\b/.test(t)) {
    return 'IA en AWS';
  }
  if (/\b(nube|cloud|aws|infraestructura|servidor|servidores|migraci[oó]n|migracion|arquitectura)\b/.test(t)) {
    return 'Arquitectura en la nube';
  }
  if (/\b(datos|anal[ií]tica|analitica|dashboard|tablero|reporte|reportes|bi)\b/.test(t)) {
    return 'Datos y analítica';
  }
  return null;
}

async function askBedrock(userText) {
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: 'user', content: [{ text: userText }] }],
      inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0.3, topP: 0.9 },
    }),
  );
  return (
    res.output?.message?.content?.[0]?.text?.trim() ||
    'Lo siento, no pude generar una respuesta. ¿Me lo preguntas de otra forma?'
  );
}

async function answerWithBedrock(event, intentName) {
  const userText = (event.inputTranscript ?? '').trim();
  if (!userText) {
    return elicitIntentBedrock(event, '¿Me repites tu pregunta, por favor?');
  }

  const stage = getOfferStage(event);

  // --- The visitor is replying to our soft proposal offer -----------------
  if (stage === 'offered') {
    // a) They accepted → hand off into the lead form.
    if (AFFIRMATIVE_RE.test(userText) && !NEGATIVE_RE.test(userText)) {
      return startLeadForm(event);
    }
    // b) They declined → gracious + one soft email-only ask.
    if (NEGATIVE_RE.test(userText)) {
      return elicitIntentBedrock(
        event,
        '¡Claro, sin problema! Si quieres, déjame solo tu correo y te mando info cuando gustes ' +
          '— o escríbenos a hola@altioraestudio.com cuando estés listo. 😊',
        { offerStage: 'declined' },
      );
    }
    // c) Neither — treat as another question. Answer, keep the offer open.
    const ans = await safeAnswer(userText);
    const svc = detectService(userText);
    return elicitIntentBedrock(
      event,
      ans,
      svc ? { offerStage: 'offered', detectedServicio: svc } : { offerStage: 'offered' },
    );
  }

  // --- We already asked once more after a "no" ----------------------------
  if (stage === 'declined') {
    const email = extractEmail(userText);
    if (email) {
      await savePartialLead(email, event);
      return closeBedrock(
        '¡Gracias! Guardé tu correo y te escribiremos pronto. 🙌 ¿Algo más en lo que te ayude?',
        event,
        { offerStage: 'captured' },
      );
    }
    // Still no email → answer if it's a question, then back off gracefully.
    const ans = await safeAnswer(userText);
    return elicitIntentBedrock(
      event,
      ans + '\n\nAquí estaré si necesitas algo más. 😊',
      { offerStage: 'done' },
    );
  }

  // --- Default: answer the question, then SOFTLY offer a proposal ---------
  const ans = await safeAnswer(userText);
  const invite =
    '\n\n¿Te preparo una propuesta sin compromiso? Si quieres, con gusto tomo tus datos.';
  const svc = detectService(userText);
  return elicitIntentBedrock(
    event,
    ans + invite,
    svc ? { offerStage: 'offered', detectedServicio: svc } : { offerStage: 'offered' },
  );
}

/** Bedrock answer with its own error fallback (never throws). */
async function safeAnswer(userText) {
  try {
    return await askBedrock(userText);
  } catch (err) {
    console.error('Bedrock Converse failed:', err);
    return 'Uy, tuve un problema para responder. Escríbenos a hola@altioraestudio.com y te ayudamos enseguida.';
  }
}

/**
 * Hand off into the lead form: start SolicitarServicio.
 *
 * If we detected the service earlier in the conversation (session attribute
 * `detectedServicio`), pre-fill the `servicio` slot and jump straight to asking
 * for the name — so we don't redundantly ask "¿qué servicio?" when the visitor
 * just asked about, say, a chatbot. Otherwise, ask for the service.
 */
function startLeadForm(event) {
  const detected = event.sessionState?.sessionAttributes?.detectedServicio;

  if (detected) {
    return {
      sessionState: {
        sessionAttributes: sessionAttrs(event, { offerStage: 'capturing' }),
        dialogAction: { type: 'ElicitSlot', slotToElicit: 'nombre' },
        intent: {
          name: 'SolicitarServicio',
          state: 'InProgress',
          slots: {
            servicio: {
              value: {
                originalValue: detected,
                interpretedValue: detected,
                resolvedValues: [detected],
              },
            },
          },
        },
      },
      messages: [
        {
          contentType: 'PlainText',
          content: `¡Genial! Preparo una propuesta de ${detected}. ¿Cómo te llamas?`,
        },
      ],
    };
  }

  return {
    sessionState: {
      sessionAttributes: sessionAttrs(event, { offerStage: 'capturing' }),
      dialogAction: { type: 'ElicitSlot', slotToElicit: 'servicio' },
      intent: { name: 'SolicitarServicio', state: 'InProgress' },
    },
    messages: [
      {
        contentType: 'PlainText',
        content:
          '¡Genial! ¿Qué servicio te interesa: IA en AWS, software a medida, ' +
          'arquitectura en la nube o datos y analítica?',
      },
    ],
  };
}

/** Save an email-only partial lead (the soft "no" path). */
async function savePartialLead(email, event) {
  if (!isValidEmail(email)) return;
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          createdAt: new Date().toISOString(),
          email,
          nombre: null,
          servicio: null,
          intent: 'PartialLead',
          sessionId: event.sessionId ?? null,
          locale: event.bot?.localeId ?? null,
        },
      }),
    );
    console.log('Partial lead saved:', email);
  } catch (err) {
    console.error('Partial lead put failed:', err);
  }
}

/**
 * Keep the conversation open on the FallbackIntent (ElicitIntent) so the next
 * user message comes back to this Lambda, carrying updated session attributes.
 */
function elicitIntentBedrock(event, content, extraAttrs = {}) {
  return {
    sessionState: {
      sessionAttributes: sessionAttrs(event, extraAttrs),
      dialogAction: { type: 'ElicitIntent' },
    },
    messages: [{ contentType: 'PlainText', content }],
  };
}

/** Close the Bedrock conversation (keeps session attributes). */
function closeBedrock(content, event, extraAttrs = {}) {
  return {
    sessionState: {
      sessionAttributes: sessionAttrs(event, extraAttrs),
      dialogAction: { type: 'ElicitIntent' },
    },
    messages: [{ contentType: 'PlainText', content }],
  };
}

// ---------------------------------------------------------------------------
// Lex response helpers
// ---------------------------------------------------------------------------

/** Close the conversation with a message. */
function close(intentName, content) {
  return {
    sessionState: {
      dialogAction: { type: 'Close' },
      intent: { name: intentName, state: 'Fulfilled' },
    },
    messages: [{ contentType: 'PlainText', content }],
  };
}

/** Re-ask for a specific slot (used when validation fails). */
function elicitSlot(intentName, slots, slotToElicit, content) {
  return {
    sessionState: {
      dialogAction: { type: 'ElicitSlot', slotToElicit },
      intent: {
        name: intentName,
        state: 'InProgress',
        // Clear the bad value so Lex re-collects it.
        slots: { ...slots, [slotToElicit]: null },
      },
    },
    messages: [{ contentType: 'PlainText', content }],
  };
}
