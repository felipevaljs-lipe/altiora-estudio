import { Component, HostListener, computed, signal } from '@angular/core';

interface NavLink {
  label: string;
  href: string;
}

@Component({
  selector: 'en-header',
  imports: [],
  templateUrl: './header.html',
  styleUrl: './header.css',
})
export class Header {
  private readonly scrolled = signal(false);
  protected readonly menuOpen = signal(false);
  protected readonly scrolledSig = computed(() => this.scrolled());

  protected readonly links: NavLink[] = [
    { label: 'Servicios', href: '#servicios' },
    { label: 'Enfoque', href: '#enfoque' },
    { label: 'Preguntas', href: '#preguntas' }
  ];

  @HostListener('window:scroll')
  protected onScroll(): void {
    this.scrolled.set(window.scrollY > 24);
  }

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }
}
