import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export interface PollyResponse {
  audioBase64: string;
  contentType: string;
  voice: string;
}

export interface ComprehendResponse {
  language: string;
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'MIXED';
  scores: { Positive: number; Negative: number; Neutral: number; Mixed: number };
  entities: Array<{ text: string; type: string; score: number }>;
}

@Injectable({ providedIn: 'root' })
export class PlaygroundService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.playground.apiUrl;

  get configured(): boolean {
    return !!this.base;
  }

  /** Max characters accepted (mirrors the Lambda's hard cap). */
  readonly maxChars = 500;

  async polly(text: string, voice = 'es'): Promise<PollyResponse> {
    return firstValueFrom(
      this.http.post<PollyResponse>(`${this.base}/playground/polly`, { text, voice }),
    );
  }

  async comprehend(text: string): Promise<ComprehendResponse> {
    return firstValueFrom(
      this.http.post<ComprehendResponse>(`${this.base}/playground/comprehend`, { text }),
    );
  }
}
