import { Injectable, computed, signal } from '@angular/core';
import { LexLead } from './lex.service';

export interface ChatMessage {
  role: 'user' | 'bot';
  text: string;
  buttons?: Array<{ text: string; value: string }>;
}

/** Max user messages per session before the chat asks them to email instead. */
const MAX_USER_MESSAGES = 15;

/** Max characters accepted per message (also guards Bedrock input tokens). */
export const MAX_MESSAGE_CHARS = 300;

/**
 * Singleton UI state shared between the hero inline chat and the floating
 * widget. Both components read and write the same signals so the conversation
 * is continuous regardless of which surface the user is looking at.
 *
 * Also enforces a per-session interaction cap. Because AMAZON.QnAIntent calls
 * Amazon Bedrock on each unmatched question, capping how many messages a
 * visitor can send bounds the number (and cost) of model invocations a single
 * session can trigger. This is the client-side half of the guardrails; the
 * per-answer output-token limit is set on the QnAIntent model config in AWS.
 */
@Injectable({ providedIn: 'root' })
export class ChatStateService {
  readonly messages = signal<ChatMessage[]>([
    { role: 'bot', text: '¡Hola! Soy Alti, el asistente de Altiora Estudio. ¿En qué te puedo ayudar?' },
  ]);

  readonly lead = signal<LexLead | null>(null);

  readonly sending = signal(false);

  /** Shared input value so typing in one view carries over to the other. */
  readonly input = signal('');

  /** How many messages the visitor has sent this session. */
  readonly userMessageCount = signal(0);

  readonly maxUserMessages = MAX_USER_MESSAGES;
  readonly maxMessageChars = MAX_MESSAGE_CHARS;

  /** True once the visitor hits the per-session message cap. */
  readonly limitReached = computed(() => this.userMessageCount() >= MAX_USER_MESSAGES);

  addMessage(msg: ChatMessage): void {
    this.messages.update((m) => [...m, msg]);
  }

  /** Record that the visitor sent a message (for the interaction cap). */
  countUserMessage(): void {
    this.userMessageCount.update((n) => n + 1);
  }

  reset(): void {
    this.messages.set([{ role: 'bot', text: '¡Hola de nuevo! ¿En qué puedo ayudarte?' }]);
    this.lead.set(null);
    this.input.set('');
    this.userMessageCount.set(0);
  }
}
