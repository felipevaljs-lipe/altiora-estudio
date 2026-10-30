import { Component } from '@angular/core';

interface FooterCol {
  title: string;
  links: { label: string; href: string }[];
}

@Component({
  selector: 'en-footer',
  imports: [],
  templateUrl: './footer.html',
  styleUrl: './footer.css',
})
export class Footer {
  protected readonly year = new Date().getFullYear();

  protected readonly email = 'hola@altioraestudio.com';

  protected readonly columns: FooterCol[] = [
    {
      title: 'Servicios',
      links: [
        { label: 'IA en AWS', href: '#servicios' },
        { label: 'Software a medida', href: '#servicios' },
        { label: 'Arquitectura en la nube', href: '#servicios' },
        { label: 'Datos y analítica', href: '#servicios' },
      ],
    },
    {
      title: 'Estudio',
      links: [
        { label: 'Enfoque', href: '#enfoque' },
        { label: 'Preguntas', href: '#preguntas' },
        { label: 'Contacto', href: '#contacto' },
      ],
    },
  ];

  protected readonly socials = [
    { label: 'GitHub', href: 'https://github.com', icon: 'github' },
    { label: 'LinkedIn', href: 'https://linkedin.com', icon: 'linkedin' },
    { label: 'X', href: 'https://x.com', icon: 'x' },
  ];
}
