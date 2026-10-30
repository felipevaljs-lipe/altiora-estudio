import { Injectable, signal } from '@angular/core';
import {
  LexRuntimeV2Client,
  RecognizeTextCommand,
  type RecognizeTextCommandOutput,
} from '@aws-sdk/client-lex-runtime-v2';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-provider-cognito-identity';

import { environment } from '../../environments/environment';

// ---------------------------------------------------------------------------
// Configuration comes from the Angular environment files
// (src/environments/environment.ts, swapped for environment.prod.ts in a
// production build). These values are not secrets — Cognito only issues
// time-limited credentials scoped to this one bot alias.
// ---------------------------------------------------------------------------
const LEX_CONFIG = environment.lex;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single message from the bot (may include an optional image-response card). */
export interface LexMessage {
  content: string;
  /** Populated when Lex returns an ImageResponseCard (button group). */
  buttons?: Array<{ text: string; value: string }>;
}

/**
 * When the intent reaches the Fulfilled state, Lex returns the captured slots.
 * We surface them here so the UI can show a summary and the app can use the
 * lead data (e.g. for future Lambda / SES storage).
 */
export interface LexLead {
  nombre?: string;
  email?: string;
  servicio?: string;
}

export interface LexResponse {
  messages: LexMessage[];
  /** Set when intent state is Fulfilled — contains the captured lead fields. */
  lead: LexLead | null;
  /** The raw dialog action type: "Close" | "ElicitSlot" | "ElicitIntent" | … */
  dialogAction: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class LexService {
  /** Becomes true after the first successful round-trip. */
  readonly online = signal(false);

  private readonly client = new LexRuntimeV2Client({
    region: LEX_CONFIG.region,
    credentials: fromCognitoIdentityPool({
      identityPoolId: LEX_CONFIG.identityPoolId,
      clientConfig: { region: LEX_CONFIG.region },
    }),
  });

  /**
   * Each user gets a new random sessionId per app load so conversations
   * don't bleed across browser sessions.
   */
  private sessionId = crypto.randomUUID();

  /**
   * Send a user message and return the structured bot response.
   * Throws on network / credential errors — callers should catch.
   */
  async send(text: string): Promise<LexResponse> {
    const raw: RecognizeTextCommandOutput = await this.client.send(
      new RecognizeTextCommand({
        botId: LEX_CONFIG.botId,
        botAliasId: LEX_CONFIG.botAliasId,
        localeId: LEX_CONFIG.localeId,
        sessionId: this.sessionId,
        text,
      }),
    );

    this.online.set(true);

    // Map messages (text + optional button cards)
    const messages: LexMessage[] = (raw.messages ?? []).map((m) => ({
      content: m.content ?? '',
      buttons:
        m.imageResponseCard?.buttons?.map((b) => ({
          text: b.text ?? '',
          value: b.value ?? '',
        })) ?? undefined,
    }));

    // Extract lead fields when the intent is fulfilled
    const intentState = raw.sessionState?.intent?.state;
    let lead: LexLead | null = null;

    if (intentState === 'Fulfilled' || intentState === 'ReadyForFulfillment') {
      const slots = raw.sessionState?.intent?.slots ?? {};
      lead = {
        nombre: this.slotValue(slots, 'nombre'),
        email: this.slotValue(slots, 'email'),
        servicio: this.slotValue(slots, 'servicio'),
      };
    }

    const dialogAction =
      raw.sessionState?.dialogAction?.type ?? null;

    return { messages, lead, dialogAction };
  }

  /** Start a brand-new conversation (new sessionId). */
  reset(): void {
    this.sessionId = crypto.randomUUID();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private slotValue(
    slots: Record<string, unknown>,
    name: string,
  ): string | undefined {
    const slot = slots[name] as
      | { value?: { interpretedValue?: string; originalValue?: string } }
      | null
      | undefined;
    return slot?.value?.interpretedValue ?? slot?.value?.originalValue;
  }
}
