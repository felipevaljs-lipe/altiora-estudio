import { Component } from '@angular/core';
import { Chatbot } from '../chatbot/chatbot';

@Component({
  selector: 'en-hero',
  imports: [Chatbot],
  templateUrl: './hero.html',
  styleUrl: './hero.css',
})
export class Hero {}
