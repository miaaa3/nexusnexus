import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import { SelectionService } from '../core/selection.service';

interface LegendItem {
  swatch: string;          // CSS color OR gradient
  label:  string;
  hint?:  string;
}

interface LegendBlock {
  visible: () => boolean;
  title:   string;
  items:   LegendItem[];
}

/**
 * Overlay flottant en bas à droite de la carte qui explique les couleurs.
 *
 * Adapté aux calques activés : ne montre que les sections pertinentes :
 *  - Véhicules : toujours visible
 *  - Congestion IRIS : visible si calque IRIS allumé
 *  - Bordures par type IRIS : visible si calque IRIS allumé
 *  - Trajet sélectionné : visible si un véhicule est sélectionné
 *
 * Bouton pour replier/déplier toute la légende.
 */
@Component({
  selector: 'app-map-legend',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="legend"
         [class.legend--collapsed]="collapsed()"
         (click)="onContainerClick($event)">

      <div class="legend-header" (click)="toggle()">
        <span class="legend-title">LÉGENDE</span>
        <span class="legend-chev">{{ collapsed() ? '▴' : '▾' }}</span>
      </div>

      @if (!collapsed()) {
        @for (block of blocks; track block.title) {
          @if (block.visible()) {
            <div class="legend-block">
              <div class="legend-block-title">{{ block.title }}</div>
              @for (i of block.items; track i.label) {
                <div class="legend-row" [title]="i.hint || ''">
                  <span class="legend-swatch" [style.background]="i.swatch"></span>
                  <span class="legend-lbl">{{ i.label }}</span>
                </div>
              }
            </div>
          }
        }
      }
    </div>
  `,
  styles: [`
    :host {
      position: absolute;
      right: 14px;
      bottom: 14px;
      z-index: 10;
      pointer-events: none;
    }
    .legend {
      pointer-events: auto;
      min-width: 175px;
      max-width: 200px;
      background: rgba(10, 14, 26, 0.86);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 10px;
      padding: 9px 11px 11px 11px;
      backdrop-filter: blur(12px);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      color: rgba(255, 255, 255, 0.92);
      font: 11px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      user-select: none;
    }
    .legend--collapsed { padding: 7px 11px; }

    .legend-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      padding-bottom: 3px;
    }
    .legend-title {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1.6px;
      color: rgba(255, 255, 255, 0.85);
    }
    .legend-chev {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.55);
    }

    .legend-block { margin-top: 8px; }
    .legend-block-title {
      font-size: 9.5px;
      font-weight: 600;
      letter-spacing: 0.6px;
      color: rgba(255, 255, 255, 0.55);
      margin-bottom: 4px;
      text-transform: uppercase;
    }

    .legend-row {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 2px 0;
    }
    .legend-swatch {
      flex: 0 0 14px;
      width: 14px;
      height: 14px;
      border-radius: 3px;
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .legend-lbl {
      font-size: 10.5px;
      color: rgba(255, 255, 255, 0.85);
    }
  `],
})
export class MapLegendComponent {

  protected selection = inject(SelectionService);
  protected collapsed = signal<boolean>(false);

  toggle(): void { this.collapsed.update(v => !v); }
  onContainerClick(_e: Event): void { /* prevent map click bleed via z-index */ }

  protected readonly blocks: LegendBlock[] = [
    {
      visible: () => true,
      title:   'Véhicules',
      items: [
        { swatch: '#3399ff', label: 'Voiture',     hint: 'Type CAR' },
        { swatch: '#1ad966', label: 'Bus',         hint: 'Type BUS' },
        { swatch: '#ffa61a', label: 'Camion',      hint: 'Type TRUCK' },
        { swatch: '#cc33e6', label: 'Moto',        hint: 'Type MOTORCYCLE' },
        { swatch: '#ff2626', label: 'Urgence',     hint: 'EMERGENCY — bypasse les feux rouges' },
        { swatch: '#ff1f0d', label: 'Épave',       hint: 'Véhicule accidenté' },
      ],
    },
    {
      visible: () => this.selection.filters().irisEnabled,
      title:   'Congestion IRIS',
      items: [
        { swatch: 'linear-gradient(90deg, #2ecc71, #f1c40f, #e67e22, #e74c3c, #c0392b)',
          label:  'Fluide → engorgé',
          hint:   '0% (vert) → 100% (rouge)' },
      ],
    },
    {
      visible: () => this.selection.filters().irisEnabled,
      title:   'Bordures IRIS',
      items: [
        { swatch: '#3d9eff', label: 'Habitat (H)',       hint: 'Zone résidentielle' },
        { swatch: '#e67e22', label: 'Activité (A)',      hint: 'Commerce / industrie' },
        { swatch: '#9b59b6', label: 'Divers (D)',        hint: 'Zone mixte' },
        { swatch: '#2ecc71', label: 'Zone spéciale (Z)', hint: 'Parc, gare, équipement' },
      ],
    },
    {
      visible: () => this.selection.filters().incidentsEnabled,
      title:   'Incidents',
      items: [
        { swatch: '#e74c3c', label: 'Accident' },
        { swatch: '#e67e22', label: 'Fermeture' },
        { swatch: '#f1c40f', label: 'Congestion' },
        { swatch: '#3498db', label: 'Travaux' },
      ],
    },
    {
      visible: () => this.selection.selectedVehicle() !== null,
      title:   'Sélection',
      items: [
        { swatch: 'linear-gradient(90deg, rgba(61,158,255,.6), #3df0ff, #fff)',
          label:  'Trajet A* restant' },
      ],
    },
  ];
}
