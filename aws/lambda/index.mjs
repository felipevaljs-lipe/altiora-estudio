// ---------------------------------------------------------------------------
// Altiora Estudio — conversational chatbot Lambda ("Alti")
//
// Architecture: Bedrock-driven. Lex routes (almost) every message to the
// FallbackIntent, which invokes this Lambda. Amazon Nova carries the whole
// conversation — it answers questions AND, when the visitor wants a proposal,
// collects name + email conversationally. This Lambda persists the lead to
// DynamoDB once Nova reports it has the needed info. There is NO Lex slot form.
//
// Each turn we ask Nova for a small JSON object:
//   { "reply": "<what Alti says>", "lead": { "nombre","email","servicio" } | null }
// `lead` is non-null only once Nova has gathered all three. We save it then.
//
// Conversation history is kept in a Lex session attribute so Nova has context.
//
// Runtime: Node.js 20.x (ESM). Bundled AWS SDK v3.
// ---------------------------------------------------------------------------

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE_NAME = process.env.LEADS_TABLE || 'EstudioNubeLeads';
const SES_FROM = process.env.SES_FROM;
const SES_TO = process.env.SES_TO;
const BEDROCK_MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.nova-micro-v1:0';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 500);

// Cap how many turns of history we keep (keeps tokens + session size bounded).
const MAX_HISTORY_TURNS = 12;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ses = SES_FROM && SES_TO ? new SESClient({ region: REGION }) : null;
const bedrock = new BedrockRuntimeClient({ region: REGION });

// ---------------------------------------------------------------------------
// System prompt — Alti's persona, knowledge, and the JSON contract.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Eres "Alti", el asistente virtual de Altiora Estudio. Conversas en español, de forma breve, cálida y natural (2-4 frases por respuesta). Tu objetivo es ayudar a la persona y, cuando muestre interés, conseguir sus datos para que el equipo le prepare una propuesta.

SOBRE ALTIORA ESTUDIO
Estudio de software e inteligencia artificial. Construimos soluciones a la medida: chatbots con IA, aplicaciones web y móviles, landing pages y sitios, APIs e integraciones, y arquitectura en la nube con AWS. Diseño cuidado + ingeniería sólida. Trabajamos por sprints y acompañamos tras el lanzamiento. Atención remota en México y Latinoamérica, español e inglés.

SERVICIOS
- IA en AWS: chatbots/asistentes (Amazon Lex + Bedrock), voz (Polly), transcripción (Transcribe), visión (Rekognition), análisis de texto (Comprehend), IA generativa (Bedrock).
- Software a medida (web y móvil).
- Landing pages y sitios.
- APIs e integraciones.
- Arquitectura en la nube (AWS).
- Datos y analítica.

PRECIOS (referenciales, MXN + IVA; el precio final se confirma en propuesta)
- Landing page: desde $12,000. Sitio web: desde $25,000. App web a medida (MVP): desde $80,000. Chatbot con IA: desde $35,000. Integración/API: desde $20,000. Arquitectura/migración nube: desde $18,000. Soporte: desde $4,000/mes. Pago: 50% anticipo, resto contra entregas.

PROCESO Y TIEMPOS
4 etapas: Descubrimiento, Diseño, Desarrollo (sprints), Lanzamiento. Landing 1-2 semanas; sitio 2-4; MVP o chatbot 4-8, según alcance.

CÓMO CONVERSAR
- Responde preguntas sobre servicios, precios, proceso o dudas generales ("¿qué es un chatbot?").
- Sí usas Polly, Lex, Bedrock, etc. — son parte de lo que ofrecemos.
- Cuando la persona muestre interés en un servicio o pida cotizar, ofrece de forma natural prepararle una propuesta y pídele su NOMBRE y luego su CORREO (uno a la vez, sin presionar).
- Nunca confirmes un precio final: da el rango e invita a la propuesta.
- Solo hablas de Altiora Estudio. Si preguntan otra cosa, redirige con amabilidad.
- No inventes datos que no estén aquí.

FORMATO DE RESPUESTA (MUY IMPORTANTE)
Responde SIEMPRE con un único objeto JSON válido, sin texto adicional, con esta forma:
{"reply": "<lo que le dices a la persona>", "lead": null}
Reglas para el objeto "lead":
- Déjalo en null MIENTRAS no tengas los tres datos.
- NUNCA inventes un correo. Solo pon un correo en "lead.email" si la persona lo escribió literalmente en el chat (contiene @ y dominio). Si aún no lo escribió, "lead" es null y pídeselo.
- Pide primero el nombre; el correo después.
- En cuanto tengas nombre + el correo que la persona escribió + servicio, devuelve "lead" lleno y un "reply" que AGRADECE y confirma que lo contactaremos. No vuelvas a pedir datos ya dados.
- "servicio" debe ser EXACTAMENTE uno de: "IA en AWS", "Software a medida", "Arquitectura en la nube", "Datos y analítica". Dedúcelo de la conversación.`;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export const handler = async (event) => {
  console.log('Lex event intent:', event.sessionState?.intent?.name,
              '| input:', event.inputTranscript);

  const intentName = event.sessionState?.intent?.name ?? 'FallbackIntent';
  const userText = (event.inputTranscript ?? '').trim();

  if (!userText) {
    return respond(event, intentName, '¿Me repites, por favor?', []);
  }

  // Load prior conversation history from session attributes.
  const history = readHistory(event);

  // Build the message list: history + this user turn.
  const messages = [
    ...history,
    { role: 'user', content: [{ text: userText }] },
  ];

  let reply = 'Perdón, ¿me lo preguntas de otra forma?';
  let lead = null;

  try {
    const raw = await askNova(messages);
    const parsed = parseNova(raw);
    reply = parsed.reply || reply;
    lead = parsed.lead;
  } catch (err) {
    console.error('Nova error:', err);
    return respond(
      event,
      intentName,
      'Uy, tuve un problema para responder. Escríbenos a hola@altioraestudio.com y te ayudamos enseguida.',
      history,
    );
  }

  // --- Server-side lead assembly (don't trust Nova's JSON discipline) -----
  // We accumulate the three fields in session attributes as the conversation
  // reveals them. Nova's `lead` object is used as a hint, but the email MUST
  // be one the user actually typed, and the save is triggered by the Lambda,
  // not by Nova remembering to emit a lead.
  const prevAttrs = event.sessionState?.sessionAttributes ?? {};
  const typedEmails = emailsFromUserTurns(messages);
  const latestTypedEmail = typedEmails.length ? typedEmails[typedEmails.length - 1] : null;

  // Name: prefer Nova's extracted name; otherwise keep what we had.
  const knownNombre = (lead && lead.nombre) || prevAttrs.leadNombre || null;
  // Service: prefer Nova's (normalized); otherwise keep what we had.
  const knownServicio = lead && lead.servicio
    ? normalizeServicio(lead.servicio)
    : prevAttrs.leadServicio || null;
  // Email: only ever an address the user literally typed.
  const knownEmail = latestTypedEmail || prevAttrs.leadEmail || null;

  // Stash progress so the next turn remembers.
  const leadAttrs = {};
  if (knownNombre) leadAttrs.leadNombre = knownNombre;
  if (knownServicio) leadAttrs.leadServicio = knownServicio;
  if (knownEmail) leadAttrs.leadEmail = knownEmail;

  // Save once we have all three and haven't saved this email yet.
  if (knownNombre && knownServicio && knownEmail && isValidEmail(knownEmail) &&
      prevAttrs.leadSaved !== knownEmail) {
    await saveLead(
      { nombre: knownNombre, email: knownEmail, servicio: knownServicio },
      event,
    );
    leadAttrs.leadSaved = knownEmail;
    // Guarantee a proper confirmation even if Nova's reply was weak.
    if (!/graci|contact|pronto/i.test(reply)) {
      reply = `¡Gracias, ${knownNombre}! 🙌 Registramos tu interés en ${knownServicio} y te contactaremos muy pronto a ${knownEmail}. ¿Algo más en lo que te ayude?`;
    }
  }

  // Append this turn to history for next time.
  const newHistory = [
    ...history,
    { role: 'user', content: [{ text: userText }] },
    { role: 'assistant', content: [{ text: reply }] },
  ];

  return respond(event, intentName, reply, newHistory, leadAttrs);
};

// ---------------------------------------------------------------------------
// Nova call + parsing
// ---------------------------------------------------------------------------
async function askNova(messages) {
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: BEDROCK_MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      inferenceConfig: { maxTokens: MAX_TOKENS, temperature: 0.4, topP: 0.9 },
    }),
  );
  return res.output?.message?.content?.[0]?.text?.trim() ?? '';
}

/**
 * Parse Nova's JSON reply. Nova is told to return pure JSON, but models
 * sometimes wrap it in prose or code fences — so we extract the first {...}
 * block and fall back to treating the whole thing as the reply text.
 */
function parseNova(raw) {
  if (!raw) return { reply: '', lead: null };

  // Strip code fences if present.
  let s = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();

  // Find the first balanced-looking JSON object.
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const candidate = s.slice(start, end + 1);
    try {
      const obj = JSON.parse(candidate);
      return {
        reply: typeof obj.reply === 'string' ? obj.reply : '',
        lead: obj.lead && typeof obj.lead === 'object' ? obj.lead : null,
      };
    } catch {
      // fall through
    }
  }
  // Not JSON — treat the raw text as the reply (never show JSON to the user).
  return { reply: raw, lead: null };
}

// ---------------------------------------------------------------------------
// History in session attributes (JSON-encoded, capped)
// ---------------------------------------------------------------------------
function readHistory(event) {
  const raw = event.sessionState?.sessionAttributes?.history;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function trimHistory(history) {
  // Keep only the last N turns (each turn = user + assistant = 2 entries).
  const max = MAX_HISTORY_TURNS * 2;
  return history.length > max ? history.slice(history.length - max) : history;
}

// ---------------------------------------------------------------------------
// Lex response — always ElicitIntent so the next message returns here with
// our updated session attributes (keeps the conversation on the Lambda).
// ---------------------------------------------------------------------------
function respond(event, intentName, reply, history, extraAttrs = {}) {
  const prev = event.sessionState?.sessionAttributes ?? {};
  const attrs = {
    ...prev,
    ...extraAttrs,
    history: JSON.stringify(trimHistory(history)),
  };

  return {
    sessionState: {
      sessionAttributes: attrs,
      dialogAction: { type: 'ElicitIntent' },
    },
    messages: [{ contentType: 'PlainText', content: reply }],
  };
}

// ---------------------------------------------------------------------------
// Lead persistence
// ---------------------------------------------------------------------------
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}

/** All emails the USER actually typed across the conversation (lowercased). */
function emailsFromUserTurns(messages) {
  const found = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const text = m.content?.[0]?.text ?? '';
    const matches = text.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/g);
    if (matches) found.push(...matches.map((e) => e.trim().toLowerCase()));
  }
  return found;
}

/** Snap whatever Nova wrote to one of the four canonical service values. */
function normalizeServicio(s) {
  const t = String(s || '').toLowerCase();
  if (/\b(ia|inteligencia|chatbot|lex|bedrock|polly|voz|visi[oó]n)\b/.test(t)) return 'IA en AWS';
  if (/\b(landing|sitio|p[aá]gina|web|app|aplicaci[oó]n|software|m[oó]vil|desarrollo)\b/.test(t)) return 'Software a medida';
  if (/\b(nube|cloud|aws|infraestructura|arquitectura|migraci[oó]n|servidor)\b/.test(t)) return 'Arquitectura en la nube';
  if (/\b(datos|anal[ií]tica|dashboard|tablero|reporte|bi)\b/.test(t)) return 'Datos y analítica';
  return s; // leave as-is if unrecognized
}

async function saveLead(lead, event) {
  // Rate-limit per email so a reload/retry doesn't write duplicates.
  const allowed = await passesRateLimit(lead.email);
  if (!allowed) {
    console.log('Lead rate-limited (duplicate), skipping save:', lead.email);
    return;
  }

  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    nombre: lead.nombre ?? null,
    email: lead.email,
    servicio: lead.servicio ?? null,
    intent: 'ChatLead',
    sessionId: event.sessionId ?? null,
    locale: event.bot?.localeId ?? null,
  };

  try {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    console.log('Lead saved:', item.id, item.email);
  } catch (err) {
    console.error('DynamoDB put failed:', err);
  }

  if (ses) {
    try {
      await ses.send(
        new SendEmailCommand({
          Source: SES_FROM,
          Destination: { ToAddresses: [SES_TO] },
          ReplyToAddresses: [item.email],
          Message: {
            Subject: { Data: `Nuevo lead (chat): ${item.servicio ?? 'Consulta'} — ${item.nombre ?? ''}` },
            Body: {
              Text: {
                Data: [
                  'Nuevo lead desde el chat de Alti',
                  '',
                  `Nombre:   ${item.nombre ?? '-'}`,
                  `Email:    ${item.email}`,
                  `Servicio: ${item.servicio ?? '-'}`,
                  `Fecha:    ${item.createdAt}`,
                ].join('\n'),
              },
            },
          },
        }),
      );
      console.log('Lead email sent to', SES_TO);
    } catch (err) {
      console.error('SES send failed (lead still saved):', err);
    }
  }
}

// Dedup guard: one lead per email per window, via conditional write + TTL.
const RATE_LIMIT_WINDOW_SECONDS = 300;
async function passesRateLimit(email) {
  const now = Math.floor(Date.now() / 1000);
  const key = `rl#${String(email).trim().toLowerCase()}`;
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { id: key, ttl: now + RATE_LIMIT_WINDOW_SECONDS, kind: 'ratelimit' },
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
    return true;
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') return false;
    console.error('Rate-limit check error (allowing):', err);
    return true;
  }
}
