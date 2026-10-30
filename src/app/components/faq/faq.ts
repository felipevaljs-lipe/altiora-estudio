import { Component, signal } from '@angular/core';
import { RevealDirective } from '../../directives/reveal.directive';

interface FaqItem {
  q: string;
  a: string;
}

@Component({
  selector: 'en-faq',
  imports: [RevealDirective],
  templateUrl: './faq.html',
  styleUrl: './faq.css',
})
export class Faq {
  protected readonly open = signal<number | null>(0);

  protected readonly items: FaqItem[] = [
    {
      q: '¿Qué servicios de IA ofrecen?',
      a: 'Trabajamos con la familia de servicios de IA de AWS: Amazon Lex para chatbots, Bedrock para IA generativa, Polly para voz, Transcribe para voz a texto, Rekognition para visión y Comprehend para análisis de texto. Los integramos en soluciones completas para tu negocio.'
    },
    {
      q: '¿Pueden integrar IA con mis sistemas actuales?',
      a: 'Sí. Diseñamos integraciones y APIs para conectar la IA con tus herramientas, bases de datos y procesos existentes, sin necesidad de reemplazar todo lo que ya funciona.'
    },
    {
      q: '¿Cuánto cuesta un proyecto?',
      a: 'Depende del alcance y los servicios de AWS involucrados. Tras una primera conversación te proponemos un plan por fases con presupuesto claro y sin sorpresas.',
    },
    {
      q: '¿Ofrecen soporte después del lanzamiento?',
      a: 'Por supuesto. Acompañamos tu solución con mantenimiento, mejoras y monitorización para que siga rindiendo y evolucionando junto a tu negocio.'
    }
  ];

  protected toggle(index: number): void {
    this.open.update((current) => (current === index ? null : index));
  }
}
