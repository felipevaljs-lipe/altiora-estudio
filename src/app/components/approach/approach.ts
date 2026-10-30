import { Component } from '@angular/core';
import { RevealDirective } from '../../directives/reveal.directive';

interface Step {
  num: string;
  title: string;
  desc: string;
}

@Component({
  selector: 'en-approach',
  imports: [RevealDirective],
  templateUrl: './approach.html',
  styleUrl: './approach.css',
})
export class Approach {
  protected readonly steps: Step[] = [
    {
      num: '01',
      title: 'Descubrimiento',
      desc: 'Entendemos tu negocio y el problema real que quieres resolver.',
    },
    {
      num: '02',
      title: 'Diseño',
      desc: 'Definimos la experiencia y la arquitectura con foco en valor.',
    },
    {
      num: '03',
      title: 'Desarrollo',
      desc: 'Construimos en iteraciones con IA y software de calidad.',
    },
    {
      num: '04',
      title: 'Lanzamiento',
      desc: 'Desplegamos en AWS, medimos resultados y mejoramos continuamente.',
    },
  ];
}
