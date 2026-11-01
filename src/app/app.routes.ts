import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./components/home/home').then((m) => m.Home),
  },
  {
    path: 'playground',
    loadComponent: () => import('./components/playground/playground').then((m) => m.Playground),
    title: 'Playground · Altiora Estudio',
  },
  { path: '**', redirectTo: '' },
];
