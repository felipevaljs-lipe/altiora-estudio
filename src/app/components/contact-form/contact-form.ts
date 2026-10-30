import {
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { ContactPayload, ContactService } from '../../services/contact.service';

type Status = 'idle' | 'sending' | 'sent' | 'error';

@Component({
  selector: 'en-contact-form',
  imports: [],
  templateUrl: './contact-form.html',
  styleUrl: './contact-form.css',
})
export class ContactForm {
  /** Emitted when the overlay should close. */
  readonly closed = output<void>();

  private readonly contact = inject(ContactService);

  protected readonly servicios = [
    'IA en AWS',
    'Software a medida',
    'Arquitectura en la nube',
    'Datos y analítica',
    'Otro',
  ];

  protected readonly nombre = signal('');
  protected readonly email = signal('');
  protected readonly servicio = signal('');
  protected readonly mensaje = signal('');
  protected readonly website = signal(''); // honeypot

  protected readonly status = signal<Status>('idle');
  protected readonly errorMsg = signal<string | null>(null);

  protected readonly emailValid = computed(() =>
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(this.email().trim()),
  );
  protected readonly canSubmit = computed(
    () => this.emailValid() && this.status() !== 'sending',
  );

  @ViewChild('firstField') private firstField?: ElementRef<HTMLInputElement>;

  ngAfterViewInit(): void {
    setTimeout(() => this.firstField?.nativeElement.focus(), 80);
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.close();
  }

  protected close(): void {
    this.closed.emit();
  }

  /** Close only when the backdrop itself (not the dialog) is clicked. */
  protected onBackdrop(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('cf-backdrop')) {
      this.close();
    }
  }

  protected async submit(): Promise<void> {
    if (!this.canSubmit()) return;

    const payload: ContactPayload = {
      nombre: this.nombre().trim(),
      email: this.email().trim(),
      servicio: this.servicio().trim(),
      mensaje: this.mensaje().trim(),
      website: this.website().trim(),
    };

    this.status.set('sending');
    this.errorMsg.set(null);

    try {
      const sentViaApi = await this.contact.submit(payload);
      if (sentViaApi) {
        this.status.set('sent');
      } else {
        // No API configured → open the user's mail client as a fallback.
        window.location.href = this.contact.buildMailto(payload);
        this.status.set('sent');
      }
    } catch {
      this.status.set('error');
      this.errorMsg.set(
        'No pudimos enviar tu mensaje. Intenta de nuevo o escríbenos a ' + this.contact.email + '.',
      );
    }
  }
}
