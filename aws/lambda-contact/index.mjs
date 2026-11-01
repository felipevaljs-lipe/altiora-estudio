// ---------------------------------------------------------------------------
// Altiora Estudio — contact form handler
//
// Fronted by an API Gateway HTTP API (POST /contact). Receives the website
// contact form, writes the lead to the SAME EstudioNubeLeads table used by the
// chatbot, and optionally emails the team via SES. Returns JSON.
//
// Runtime: Node.js 20.x (ESM). Uses the bundled AWS SDK v3.
// ---------------------------------------------------------------------------

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE_NAME = process.env.LEADS_TABLE || 'EstudioNubeLeads';
const SES_FROM = process.env.SES_FROM;
const SES_TO = process.env.SES_TO;
// Comma-separated allowlist, e.g. "https://altioraestudio.com,https://www.altioraestudio.com".
// Falls back to "*" if unset. We echo back the request's Origin only if it's
// in the allowlist — the correct way to support multiple exact origins.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const ses = SES_FROM && SES_TO ? new SESClient({ region: REGION }) : null;

function pickOrigin(event) {
  if (ALLOWED_ORIGINS.includes('*')) return '*';
  const h = event?.headers ?? {};
  const origin = h.origin || h.Origin || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

function response(statusCode, body, origin = '*') {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST,OPTIONS',
      'vary': 'Origin',
    },
    body: JSON.stringify(body),
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || '').trim());
}

/** Trim + cap a field so a huge payload can't bloat the row. */
function clean(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

export const handler = async (event) => {
  const origin = pickOrigin(event);
  const method = event.requestContext?.http?.method || event.httpMethod || 'POST';
  if (method === 'OPTIONS') return response(204, {}, origin);
  if (method !== 'POST') return response(405, { error: 'Método no permitido' }, origin);

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return response(400, { error: 'Cuerpo inválido' }, origin);
  }

  const nombre = clean(data.nombre, 120);
  const email = clean(data.email, 160);
  const servicio = clean(data.servicio, 80);
  const mensaje = clean(data.mensaje, 2000);

  // Minimal validation: a valid email is the one hard requirement.
  if (!isValidEmail(email)) {
    return response(400, { error: 'Necesitamos un correo válido.' }, origin);
  }

  // Honeypot: if the hidden "website" field is filled, it's a bot. Pretend OK.
  if (clean(data.website, 10)) {
    console.log('Honeypot triggered, dropping submission.');
    return response(200, { ok: true }, origin);
  }

  const lead = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    nombre: nombre || null,
    email,
    servicio: servicio || null,
    mensaje: mensaje || null,
    intent: 'ContactForm',
    sessionId: null,
    locale: null,
  };

  try {
    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: lead }));
    console.log('Contact lead saved:', lead.id);
  } catch (err) {
    console.error('DynamoDB put failed:', err);
    return response(500, { error: 'No pudimos guardar tu mensaje. Intenta de nuevo.' }, origin);
  }

  if (ses) {
    try {
      await ses.send(
        new SendEmailCommand({
          Source: SES_FROM,
          Destination: { ToAddresses: [SES_TO] },
          ReplyToAddresses: [email],
          Message: {
            Subject: { Data: `Contacto web: ${servicio || 'Consulta'} — ${nombre || email}` },
            Body: {
              Text: {
                Data: [
                  'Nuevo mensaje desde el formulario de contacto',
                  '',
                  `Nombre:   ${nombre || '-'}`,
                  `Email:    ${email}`,
                  `Servicio: ${servicio || '-'}`,
                  `Fecha:    ${lead.createdAt}`,
                  '',
                  'Mensaje:',
                  mensaje || '-',
                ].join('\n'),
              },
            },
          },
        }),
      );
      console.log('Contact email sent to', SES_TO);
    } catch (err) {
      console.error('SES send failed (lead still saved):', err);
    }
  }

  return response(200, { ok: true }, origin);
};
