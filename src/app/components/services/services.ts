import { Component, computed, signal } from '@angular/core';
import { RevealDirective } from '../../directives/reveal.directive';

type Category = 'ia' | 'sw';
type Filter = 'all' | Category;
type Icon =
  | 'lex'
  | 'bedrock'
  | 'polly'
  | 'transcribe'
  | 'rekognition'
  | 'comprehend'
  | 'code'
  | 'cloud'
  | 'plug'
  | 'analytics';

interface Service {
  icon: Icon;
  category: Category;
  title: string;
  desc: string;
  tag: string;
}

interface FilterTab {
  id: Filter;
  label: string;
}

@Component({
  selector: 'en-services',
  imports: [RevealDirective],
  templateUrl: './services.html',
  styleUrl: './services.css',
})
export class Services {
  protected readonly filters: FilterTab[] = [
    { id: 'all', label: 'Todos' },
    { id: 'ia', label: 'IA en AWS' },
    { id: 'sw', label: 'Software' },
  ];

  protected readonly active = signal<Filter>('all');

  protected readonly services: Service[] = [
    {
      icon: 'lex',
      category: 'ia',
      title: 'Amazon Lex',
      desc: 'Chatbots y asistentes conversacionales que atienden a tus clientes 24/7.',
      tag: 'IA en AWS',
    },
    {
      icon: 'bedrock',
      category: 'ia',
      title: 'Amazon Bedrock',
      desc: 'Modelos de IA generativa integrados a tus productos y procesos.',
      tag: 'IA en AWS',
    },
    {
      icon: 'polly',
      category: 'ia',
      title: 'Amazon Polly',
      desc: 'Voces realistas con text-to-speech para apps y contenido accesible.',
      tag: 'IA en AWS',
    },
    {
      icon: 'transcribe',
      category: 'ia',
      title: 'Amazon Transcribe',
      desc: 'Conversión de voz a texto en tiempo real para notas y subtítulos.',
      tag: 'IA en AWS',
    },
    {
      icon: 'rekognition',
      category: 'ia',
      title: 'Amazon Rekognition',
      desc: 'Visión por computadora para analizar imágenes y video automáticamente.',
      tag: 'IA en AWS',
    },
    {
      icon: 'comprehend',
      category: 'ia',
      title: 'Amazon Comprehend',
      desc: 'Análisis de texto y lenguaje natural para entender a tus usuarios.',
      tag: 'IA en AWS',
    },
    {
      icon: 'code',
      category: 'sw',
      title: 'Desarrollo a medida',
      desc: 'Aplicaciones web y móviles diseñadas y construidas a tu medida.',
      tag: 'Software',
    },
    {
      icon: 'cloud',
      category: 'sw',
      title: 'Arquitectura en la nube',
      desc: 'Infraestructura en AWS escalable, segura y lista para crecer.',
      tag: 'Software',
    },
    {
      icon: 'plug',
      category: 'sw',
      title: 'Integraciones y APIs',
      desc: 'Conectamos tus sistemas, datos y herramientas en un solo flujo.',
      tag: 'Software',
    },
    // {
    //   icon: 'analytics',
    //   category: 'sw',
    //   title: 'Datos y analítica',
    //   desc: 'Cuadros de mando e insights accionables para decidir mejor.',
    //   tag: 'Software',
    // },
  ];

  protected readonly visible = computed<Service[]>(() => {
    console.log('this.active', this.active)
    const f = this.active();
    const ff = this.randomize(this.services);
    return f === 'all' ? ff : ff.filter((s) => s.category === f);
  });

  protected randomize(arr: Service[]) {
    return arr
    .map(value => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value)
  }
}
