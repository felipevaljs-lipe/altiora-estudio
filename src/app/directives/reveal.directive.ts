import {
  afterNextRender,
  Directive,
  ElementRef,
  OnDestroy,
  inject,
} from '@angular/core';

/**
 * Adds a soft fade/slide-up reveal when the element scrolls into view.
 * Honors `prefers-reduced-motion` by showing the element immediately.
 */
@Directive({
  selector: '[reveal]',
  host: { class: 'reveal' },
})
export class RevealDirective implements OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private observer?: IntersectionObserver;

  constructor() {
    afterNextRender(() => {
      const el = this.host.nativeElement;
      const reduceMotion =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      if (reduceMotion || !('IntersectionObserver' in window)) {
        el.classList.add('is-visible');
        return;
      }

      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-visible');
              this.observer?.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
      );

      this.observer.observe(el);
    });
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
