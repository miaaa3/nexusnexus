import {
  Component, inject, Output, EventEmitter
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { SelectionService } from '../core/selection.service';
import { VehicleUpdate, VEHICLE_COLORS } from '../core/models/vehicle.model';

export interface PanToEvent {
  lon: number;
  lat: number;
  vehicle: VehicleUpdate;
}

/**
 * Vehicle search panel.
 * Filters the last-known vehicle list by ID prefix, shows a short results
 * list, and emits a PanToEvent when the user picks a result so MapComponent
 * can fly to it.
 *
 * The component holds no reference to the map — it only emits coordinates.
 */
@Component({
  selector: 'app-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="search-panel">
      <div class="search-row">
        <span class="search-icon">⌕</span>
        <input
          class="search-input"
          type="text"
          placeholder="Search vehicle ID…"
          [(ngModel)]="query"
          (ngModelChange)="onQueryChange()"
          (keydown.escape)="clear()"
        />
        @if (query) {
          <button class="clear-btn" (click)="clear()">✕</button>
        }
      </div>

      @if (query && results().length > 0) {
        <div class="results">
          @for (v of results(); track v.id) {
            <button class="result-row" (click)="select(v)">
              <span class="result-dot" [style.background]="color(v)"></span>
              <span class="result-id">{{ v.id }}</span>
              <span class="result-type">{{ v.type }}</span>
              <span class="result-speed">{{ v.speed | number:'1.0-0' }} km/h</span>
            </button>
          }
        </div>
      }

      @if (query && results().length === 0) {
        <div class="no-results">No vehicles match "{{ query }}"</div>
      }
    </div>
  `,
  styles: [`
    .search-panel {
      display: flex;
      flex-direction: column;
      gap: 0;
    }

    .search-row {
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px;
      padding: 6px 10px;
      transition: border-color 0.2s;
    }

    .search-row:focus-within {
      border-color: rgba(61,158,255,0.5);
      box-shadow: 0 0 12px rgba(61,158,255,0.1);
    }

    .search-icon {
      color: rgba(255,255,255,0.3);
      font-size: 14px;
      flex-shrink: 0;
    }

    .search-input {
      flex: 1;
      background: none;
      border: none;
      outline: none;
      color: #e0e6f0;
      font-size: 11px;
      font-family: monospace;
      letter-spacing: 0.5px;
    }

    .search-input::placeholder { color: rgba(255,255,255,0.2); }

    .clear-btn {
      background: none;
      border: none;
      color: rgba(255,255,255,0.3);
      font-size: 10px;
      cursor: pointer;
      padding: 0 2px;
      flex-shrink: 0;
    }
    .clear-btn:hover { color: rgba(255,255,255,0.7); }

    .results {
      margin-top: 4px;
      background: rgba(8,12,24,0.95);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 8px;
      overflow: hidden;
      max-height: 180px;
      overflow-y: auto;
    }

    .result-row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      background: none;
      border: none;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;
    }
    .result-row:last-child { border-bottom: none; }
    .result-row:hover { background: rgba(61,158,255,0.08); }

    .result-dot {
      width: 7px;
      height: 7px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .result-id {
      font-size: 11px;
      font-weight: 700;
      color: #fff;
      font-family: monospace;
      flex: 1;
    }

    .result-type {
      font-size: 9px;
      font-weight: 600;
      color: rgba(255,255,255,0.35);
      letter-spacing: 0.8px;
      text-transform: uppercase;
    }

    .result-speed {
      font-size: 10px;
      color: rgba(255,255,255,0.4);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .no-results {
      margin-top: 4px;
      padding: 8px 10px;
      font-size: 10px;
      color: rgba(255,255,255,0.25);
      text-align: center;
    }

    /* Scrollbar */
    .results::-webkit-scrollbar { width: 3px; }
    .results::-webkit-scrollbar-track { background: transparent; }
    .results::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
  `]
})
export class SearchComponent {

  @Output() panTo = new EventEmitter<PanToEvent>();

  private sel = inject(SelectionService);

  query = '';

  // Pool of vehicles for search — updated externally via setPool().
  private pool: VehicleUpdate[] = [];

  results(): VehicleUpdate[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return [];
    return this.pool
      .filter(v => v.id.toLowerCase().startsWith(q))
      .slice(0, 8);   // max 8 results
  }

  /** Called by DashboardComponent every frame to keep the search pool fresh. */
  setPool(vehicles: VehicleUpdate[]): void {
    this.pool = vehicles;
  }

  select(v: VehicleUpdate): void {
    this.sel.select(v);
    this.panTo.emit({ lon: v.lon, lat: v.lat, vehicle: v });
    this.clear();
  }

  onQueryChange(): void { /* reactive via computed */ }

  clear(): void {
    this.query = '';
  }

  color(v: VehicleUpdate): string {
    const [r, g, b] = VEHICLE_COLORS[v.type];
    return `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
  }
}
