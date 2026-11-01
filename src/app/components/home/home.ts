import { Component } from '@angular/core';
import { Header } from '../header/header';
import { Hero } from '../hero/hero';
import { Services } from '../services/services';
import { Approach } from '../approach/approach';
import { Faq } from '../faq/faq';
import { Cta } from '../cta/cta';
import { Footer } from '../footer/footer';
import { Chatbot } from '../chatbot/chatbot';

@Component({
  selector: 'en-home',
  imports: [Header, Hero, Services, Approach, Faq, Cta, Footer, Chatbot],
  templateUrl: './home.html',
})
export class Home {}
