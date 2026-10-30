import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ContactPayload {
  nombre: string;
  email: string;
  servicio: string;
  mensaje: string;
  /** Honeypot — must stay empty; bots fill it. */
  website?: string;
}

@Injectable({ providedIn: 'root' })
export class ContactService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.contact.apiUrl;
  readonly email = environment.contact.email;

  /** True when a real API endpoint is configured (vs. mailto fallback). */
  get hasApi(): boolean {
    return !!this.apiUrl;
  }

  /**
   * Submit the contact form. Posts to the API when configured; otherwise
   * returns false so the caller can fall back to a mailto: link.
   * Throws on API/network error so the UI can show a failure state.
   */
  async submit(payload: ContactPayload): Promise<boolean> {
    if (!this.apiUrl) return false;
    await firstValueFrom(this.http.post(this.apiUrl, payload));
    return true;
  }

  /** Build a mailto: link pre-filled from the form (fallback path). */
  buildMailto(payload: ContactPayload): string {
    const subject = `Contacto web: ${payload.servicio || 'Consulta'} — ${payload.nombre || ''}`.trim();
    const body = [
      `Nombre: ${payload.nombre}`,
      `Email: ${payload.email}`,
      `Servicio: ${payload.servicio}`,
      '',
      payload.mensaje,
    ].join('\n');
    return `mailto:${this.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
}
