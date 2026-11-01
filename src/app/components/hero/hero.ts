import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Chatbot } from '../chatbot/chatbot';

@Component({
  selector: 'en-hero',
  imports: [Chatbot, RouterLink],
  templateUrl: './hero.html',
  styleUrl: './hero.css',
})
export class Hero {}
