import { Component, signal } from '@angular/core';
import { RevealDirective } from '../../directives/reveal.directive';
import { ContactForm } from '../contact-form/contact-form';

@Component({
  selector: 'en-cta',
  imports: [RevealDirective, ContactForm],
  templateUrl: './cta.html',
  styleUrl: './cta.css',
})
export class Cta {
  protected readonly email = 'hola@altioraestudio.com';
  protected readonly formOpen = signal(false);
}
