import {
  Component,
  ElementRef,
  HostListener,
  Input,
  OnDestroy,
  OnInit,
  ViewChild,
  afterNextRender,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ChatStateService } from '../../services/chat-state.service';
import { LexService } from '../../services/lex.service';

/**
 * Dual-mode chat component.
 *
 * mode="hero"   → Inline card embedded in the hero section (always visible).
 * mode="widget" → Floating launcher + slide-up panel, scroll-aware.
 *
 * All chat state (messages, lead, input, sending) lives in ChatStateService
 * so both instances share the same conversation seamlessly.
 */
@Component({
  selector: 'en-chatbot',
  imports: [],
  templateUrl: './chatbot.html',
  styleUrl: './chatbot.css',
})
export class Chatbot implements OnInit, OnDestroy {
  @Input() mode: 'hero' | 'widget' = 'widget';

  protected readonly lex = inject(LexService);
  protected readonly chat = inject(ChatStateService);

  // Convenience aliases — templates use chat.messages(), chat.lead() etc.
  protected get messages() { return this.chat.messages; }
  protected get lead()     { return this.chat.lead; }
  protected get sending()  { return this.chat.sending; }
  protected get input()    { return this.chat.input; }

  /**
   * Widget panel open state — backed by the SHARED signal so the hero chat can
   * open it too (mobile). Exposed as `open` to keep the template unchanged.
   */
  protected get open() { return this.chat.panelOpen; }

  /**
   * Widget: becomes true once the hero section leaves the viewport.
   * Starts at false so the FAB is hidden while the inline hero chat is visible.
   */
  protected readonly widgetVisible = signal(false);

  @ViewChild('body') private bodyRef?: ElementRef<HTMLDivElement>;
  @ViewChild('msgInput') private inputRef?: ElementRef<HTMLInputElement>;

  private heroObserver?: IntersectionObserver;

  constructor() {
    // Scroll to bottom on first render
    afterNextRender(() => {
      this.scrollToBottom();
    });

    // When the shared panel opens (e.g. the hero triggered it), the widget
    // instance scrolls to the latest message and focuses its input.
    effect(() => {
      if (this.mode === 'widget' && this.chat.panelOpen()) {
        setTimeout(() => {
          this.scrollToBottom();
          this.inputRef?.nativeElement.focus();
        }, 340);
      }
    });
  }

  /**
   * On narrow screens the hero chat renders its input as a LAUNCHER BUTTON
   * (not a real text field) — tapping it opens the full-screen widget panel,
   * exactly like the floating FAB. This avoids all the focus/keyboard glitches
   * of trying to intercept a real <input>. Matches the sheet CSS breakpoint.
   */
  protected readonly isMobile = signal(
    typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches,
  );

  @HostListener('window:resize')
  protected onResize(): void {
    this.isMobile.set(
      typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches,
    );
  }

  /** Hero launcher (mobile): open the shared widget panel. */
  protected openPanelFromHero(): void {
    this.chat.panelOpen.set(true);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  ngOnInit(): void {
    if (this.mode === 'widget') {
      this.setupHeroObserver();
    }
  }

  ngOnDestroy(): void {
    this.heroObserver?.disconnect();
  }

  /**
   * The widget FAB appears once the hero scrolls far enough away that
   * continuing the conversation there would be awkward. Fires at 0% and 30%
   * visibility so the crossfade starts before the hero section fully exits,
   * eliminating the dead zone where neither chat surface is accessible.
   */
  private setupHeroObserver(): void {
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      this.widgetVisible.set(true);
      return;
    }
    const hero = document.getElementById('inicio');
    if (!hero) {
      this.widgetVisible.set(true);
      return;
    }

    this.heroObserver = new IntersectionObserver(
      ([entry]) => {
        // Show widget when hero is less than 30% visible
        this.widgetVisible.set(entry.intersectionRatio < 0.3);
      },
      { threshold: [0, 0.3] },
    );
    this.heroObserver.observe(hero);
  }

  // ── Keyboard ───────────────────────────────────────────────────────────

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (this.open()) this.open.set(false);
  }

  // ── Widget controls ────────────────────────────────────────────────────

  protected toggle(): void {
    const opening = !this.open();
    this.open.set(opening);
    if (opening) {
      // Show latest messages then focus input
      setTimeout(() => {
        this.scrollToBottom();
        this.inputRef?.nativeElement.focus();
      }, 320);
    }
  }

  // ── Shared chat logic ──────────────────────────────────────────────────

  protected async send(text?: string): Promise<void> {
    if (this.chat.sending()) return;

    // Interaction cap — stop triggering Bedrock/Lex once the session limit hits.
    if (this.chat.limitReached()) {
      this.chat.addMessage({
        role: 'bot',
        text: 'Para no saturar el chat, mejor sigamos por correo: hola@altioraestudio.com. ¡Con gusto te atendemos! ☁️',
      });
      this.scrollToBottom();
      return;
    }

    // Cap message length (also bounds Bedrock input tokens).
    let msg = (text ?? this.chat.input()).trim();
    if (!msg) return;
    if (msg.length > this.chat.maxMessageChars) {
      msg = msg.slice(0, this.chat.maxMessageChars);
    }

    this.chat.addMessage({ role: 'user', text: msg });
    this.chat.countUserMessage();
    this.chat.input.set('');
    this.chat.sending.set(true);
    this.scrollToBottom();

    try {
      const res = await this.lex.send(msg);
      for (const lexMsg of res.messages) {
        this.chat.addMessage({
          role: 'bot',
          text: lexMsg.content,
          buttons: lexMsg.buttons,
        });
      }
      if (res.lead) this.chat.lead.set(res.lead);
    } catch (err) {
      console.error('[Chatbot] lex error:', err);
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.chat.addMessage({ role: 'bot', text: `Error: ${detail}` });
    } finally {
      this.chat.sending.set(false);
      this.scrollToBottom();
      this.inputRef?.nativeElement.focus();
    }
  }

  protected resetChat(): void {
    this.lex.reset();
    this.chat.reset();
  }

  protected scrollToBottom(): void {
    setTimeout(() => {
      const el = this.bodyRef?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    }, 60);
  }
}
