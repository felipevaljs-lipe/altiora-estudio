import { Component, computed, inject, signal } from '@angular/core';
import { ComprehendResponse, PlaygroundService } from '../../services/playground.service';

@Component({
  selector: 'en-playground',
  imports: [],
  templateUrl: './playground.html',
  styleUrl: './playground.css',
})
export class Playground {
  private readonly pg = inject(PlaygroundService);

  protected get configured(): boolean { return this.pg.configured; }
  protected readonly maxChars = this.pg.maxChars;

  // ── Polly (text to speech) ──────────────────────────────────────────────
  protected readonly pollyText = signal('Hola, soy la voz de Altiora Estudio. Así suena Amazon Polly.');
  protected readonly pollyLoading = signal(false);
  protected readonly pollyError = signal<string | null>(null);
  protected readonly audioUrl = signal<string | null>(null);

  protected async speak(): Promise<void> {
    const text = this.pollyText().trim();
    if (!text || this.pollyLoading()) return;
    this.pollyLoading.set(true);
    this.pollyError.set(null);
    this.audioUrl.set(null);
    try {
      const res = await this.pg.polly(text, 'es');
      // Build a playable data URL from the base64 MP3.
      this.audioUrl.set(`data:${res.contentType};base64,${res.audioBase64}`);
    } catch {
      this.pollyError.set('No se pudo generar el audio. Intenta de nuevo.');
    } finally {
      this.pollyLoading.set(false);
    }
  }

  // ── Comprehend (text analysis) ──────────────────────────────────────────
  protected readonly compText = signal('Me encantó el servicio, fue rápido y el equipo muy amable.');
  protected readonly compLoading = signal(false);
  protected readonly compError = signal<string | null>(null);
  protected readonly compResult = signal<ComprehendResponse | null>(null);

  protected async analyze(): Promise<void> {
    const text = this.compText().trim();
    if (!text || this.compLoading()) return;
    this.compLoading.set(true);
    this.compError.set(null);
    this.compResult.set(null);
    try {
      this.compResult.set(await this.pg.comprehend(text));
    } catch {
      this.compError.set('No se pudo analizar el texto. Intenta de nuevo.');
    } finally {
      this.compLoading.set(false);
    }
  }

  protected readonly sentimentLabel = computed(() => {
    const s = this.compResult()?.sentiment;
    return (
      {
        POSITIVE: 'Positivo 😊',
        NEGATIVE: 'Negativo 😟',
        NEUTRAL: 'Neutral 😐',
        MIXED: 'Mixto 🤔',
      }[s ?? 'NEUTRAL'] ?? 'Neutral'
    );
  });

  protected pct(n: number | undefined): string {
    return `${Math.round((n ?? 0) * 100)}%`;
  }
}
