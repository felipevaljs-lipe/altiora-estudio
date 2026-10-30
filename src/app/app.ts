import { Component } from '@angular/core';
import { Header } from './components/header/header';
import { Hero } from './components/hero/hero';
import { Services } from './components/services/services';
import { Approach } from './components/approach/approach';
import { Faq } from './components/faq/faq';
import { Cta } from './components/cta/cta';
import { Footer } from './components/footer/footer';
import { Chatbot } from './components/chatbot/chatbot';

@Component({
  selector: 'app-root',
  imports: [Header, Hero, Services, Approach, Faq, Cta, Footer, Chatbot],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {}
