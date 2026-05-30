import { Component } from '@angular/core';
import { MapComponent } from './map/map.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [MapComponent],
  template: `<app-map></app-map>`,
  styles: [`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      overflow: hidden;
      background: #0a0e1a;
    }
  `]
})
export class AppComponent {}
