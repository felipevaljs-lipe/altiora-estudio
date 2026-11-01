// ---------------------------------------------------------------------------
// Altiora Estudio — Playground proxy
//
// Fronts Amazon Polly (text-to-speech) and Amazon Comprehend (text analysis)
// for the public /playground page. The browser NEVER calls AWS directly — it
// posts here, through a throttled API Gateway. Inputs are capped so each call
// stays cheap, and the API has a daily quota + rate limit configured in
// setup-playground.sh.
//
// Routes (API Gateway):
//   POST /playground/polly       { text, voice? }  -> { audioBase64, contentType }
//   POST /playground/comprehend  { text }          -> { language, sentiment, scores, entities }
//
// Runtime: Node.js 20.x (ESM). Bundled AWS SDK v3.
// ---------------------------------------------------------------------------

import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import {
  ComprehendClient,
  DetectSentimentCommand,
  DetectEntitiesCommand,
  DetectDominantLanguageCommand,
} from '@aws-sdk/client-comprehend';

const REGION = process.env.AWS_REGION || 'us-east-1';
const MAX_TEXT = 500; // hard input cap (chars) — bounds cost per call

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map((o) => o.trim()).filter(Boolean);

// Comprehend supports a fixed set of languages for sentiment/entities.
const COMPREHEND_LANGS = new Set(['es', 'en', 'fr', 'de', 'it', 'pt']);

// Spanish Polly voices (neural where available).
const VOICES = { es: 'Lucia', en: 'Joanna' };

const polly = new PollyClient({ region: REGION });
const comprehend = new ComprehendClient({ region: REGION });

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

function cleanText(v) {
  return String(v ?? '').trim().slice(0, MAX_TEXT);
}

async function streamToBase64(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('base64');
}

export const handler = async (event) => {
  const origin = pickOrigin(event);
  const method = event.requestContext?.http?.method || event.httpMethod || 'POST';
  const path = event.requestContext?.http?.path || event.rawPath || '';

  if (method === 'OPTIONS') return response(204, {}, origin);
  if (method !== 'POST') return response(405, { error: 'Método no permitido' }, origin);

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return response(400, { error: 'Cuerpo inválido' }, origin);
  }

  const text = cleanText(data.text);
  if (!text) return response(400, { error: 'Escribe algo de texto.' }, origin);

  try {
    if (path.endsWith('/polly')) {
      return await handlePolly(text, data.voice, origin);
    }
    if (path.endsWith('/comprehend')) {
      return await handleComprehend(text, origin);
    }
    return response(404, { error: 'Ruta no encontrada' }, origin);
  } catch (err) {
    console.error('Playground error:', err);
    return response(500, { error: 'No se pudo procesar. Intenta de nuevo.' }, origin);
  }
};

async function handlePolly(text, voiceLang, origin) {
  const voiceId = VOICES[voiceLang] || VOICES.es;
  const res = await polly.send(
    new SynthesizeSpeechCommand({
      Text: text,
      OutputFormat: 'mp3',
      VoiceId: voiceId,
      Engine: 'neural',
    }),
  );
  const audioBase64 = await streamToBase64(res.AudioStream);
  return response(200, { audioBase64, contentType: 'audio/mpeg', voice: voiceId }, origin);
}

async function handleComprehend(text, origin) {
  // 1) Detect the dominant language, then use it (if supported) for the rest.
  const langRes = await comprehend.send(new DetectDominantLanguageCommand({ Text: text }));
  const top = (langRes.Languages ?? []).sort((a, b) => (b.Score ?? 0) - (a.Score ?? 0))[0];
  const langCode = top?.LanguageCode?.split('-')[0] || 'es';
  const useLang = COMPREHEND_LANGS.has(langCode) ? langCode : 'es';

  const [sentiment, entities] = await Promise.all([
    comprehend.send(new DetectSentimentCommand({ Text: text, LanguageCode: useLang })),
    comprehend.send(new DetectEntitiesCommand({ Text: text, LanguageCode: useLang })),
  ]);

  return response(
    200,
    {
      language: langCode,
      sentiment: sentiment.Sentiment, // POSITIVE | NEGATIVE | NEUTRAL | MIXED
      scores: sentiment.SentimentScore, // { Positive, Negative, Neutral, Mixed }
      entities: (entities.Entities ?? [])
        .filter((e) => (e.Score ?? 0) > 0.5)
        .slice(0, 12)
        .map((e) => ({ text: e.Text, type: e.Type, score: e.Score })),
    },
    origin,
  );
}
