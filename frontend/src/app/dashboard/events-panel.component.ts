import {
  Component, OnInit, OnDestroy, inject, signal, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';

import { environment } from '../../environments/environment';
import { IncidentDropService, IncidentType } from '../core/incident-drop.service';
import { IncidentLayerService } from '../map/incident-layer.service';

/** Wire shape for /api/simulation/incidents/history. */
interface IncidentHistoryEntry {
  id:          string;
  type:        IncidentType;
  severity:    number;
  lat:         number;
  lon:         number;
  label:       string;
  expiresAtMs: number;
}

interface TypeChip {
  type:  IncidentType;
  label: string;
  color: string;
  icon:  string;
}

/**
 * "Events" dashboard panel — three sub-features in one card so the user has a
 * single place to:
 *   1. Drop a new incident anywhere on the map (button + type / severity picker)
 *   2. Filter the existing Events overlay by type (chips)
 *   3. Browse the most recent ~20 incidents (history list, polls every 4 s)
 *
 * Performance: per-chip click is a cheap signal write; history polling is a
 * REST GET capped at 20 rows. No per-vehicle work.
 */
@Component({
  selector: 'app-events-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ev-card">

      <!-- ── Header ─────────────────────────────────────────────────── -->
      <div class="ev-header">
        <span class="ev-title">EVENTS</span>
        <button class="ev-drop"
                [class.ev-drop--active]="drop.active()"
                (click)="drop.toggleActive()"
                [title]="drop.active()
                  ? 'Click the map to drop, or press ESC to cancel'
                  : 'Toggle drop-event mode'">
          @if (drop.active()) { ⊘ Cancel } @else { ⊕ Drop event }
        </button>
      </div>

      <!-- ── Type + severity selector ────────────────────────────────── -->
      @if (drop.active()) {
        <div class="ev-picker">
          <div class="ev-picker-row">
            @for (c of TYPES; track c.type) {
              <button class="ev-pick-chip"
                      [class.ev-pick-chip--on]="drop.nextType() === c.type"
                      [style.--c]="c.color"
                      (click)="drop.nextType.set(c.type)"
                      [title]="c.label">
                <span class="ev-ico">{{ c.icon }}</span>{{ c.label }}
              </button>
            }
          </div>
          <div class="ev-sev-row">
            <span class="ev-sev-lbl">Sévérité</span>
            @for (s of [1, 2, 3]; track s) {
              <button class="ev-sev-chip"
                      [class.ev-sev-chip--on]="drop.nextSeverity() === s"
                      (click)="setSeverity(s)">{{ s }}</button>
            }
          </div>
          <div class="ev-hint">Cliquez sur la carte pour placer l'événement.</div>
        </div>
      }

      <!-- ── Filter chips ────────────────────────────────────────────── -->
      <div class="ev-filter-row">
        <span class="ev-filter-lbl">Filtre</span>
        <button class="ev-filter-chip"
                [class.ev-filter-chip--on]="allVisible()"
                (click)="showAll()">Tous</button>
        @for (c of TYPES; track c.type) {
          <button class="ev-filter-chip"
                  [class.ev-filter-chip--on]="visibleTypes().has(c.type)"
                  [style.--c]="c.color"
                  (click)="toggleType(c.type)">
            <span class="ev-ico">{{ c.icon }}</span>{{ c.short }}
          </button>
        }
      </div>

      <!-- ── Recent events list ──────────────────────────────────────── -->
      <div class="ev-history">
        <div class="ev-history-title">Recents</div>
        @if (history().length === 0) {
          <div class="ev-empty">Aucun événement enregistré pour l'instant.</div>
        } @else {
          @for (h of history(); track h.id) {
            <div class="ev-row" [style.--c]="colorFor(h.type)">
              <span class="ev-row-ico">{{ iconFor(h.type) }}</span>
              <div class="ev-row-main">
                <div class="ev-row-label">{{ h.label }}</div>
                <div class="ev-row-meta">
                  sév {{ h.severity }} · {{ h.lat | number:'1.4-4' }},
                  {{ h.lon | number:'1.4-4' }}
                </div>
              </div>
              <span class="ev-row-state"
                    [class.ev-row-state--gone]="isExpired(h)">
                {{ isExpired(h) ? '✓' : remaining(h) + 's' }}
              </span>
            </div>
          }
        }
      </div>

    </div>
  `,
  styles: [`
    :host { display: block; }

    .ev-card { display: flex; flex-direction: column; gap: 8px; }

    .ev-header {
      display: flex; justify-content: space-between; align-items: center;
    }
    .ev-title {
      font-size: 10px; font-weight: 700; letter-spacing: 1.4px;
      color: rgba(255,255,255,.85);
    }
    .ev-drop {
      font: 600 10.5px/1 inherit;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.03);
      color: rgba(255,255,255,.85);
      cursor: pointer;
      transition: background .15s ease, border-color .15s ease;
    }
    .ev-drop:hover { background: rgba(61,158,255,.1); border-color: rgba(61,158,255,.35); }
    .ev-drop--active {
      background: rgba(231,76,60,.18);
      border-color: rgba(231,76,60,.55);
      color: #ffe1dc;
    }

    .ev-picker, .ev-history {
      padding: 7px; border-radius: 7px;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.05);
    }
    .ev-picker-row, .ev-sev-row, .ev-filter-row {
      display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    }
    .ev-sev-row { margin-top: 5px; }
    .ev-sev-lbl, .ev-filter-lbl {
      font-size: 10px; color: rgba(255,255,255,.5); margin-right: 4px;
    }
    .ev-hint {
      margin-top: 5px;
      font-size: 10px;
      color: rgba(255,255,255,.6);
    }

    .ev-pick-chip, .ev-sev-chip, .ev-filter-chip {
      font: 500 10.5px/1 inherit;
      padding: 5px 8px;
      border-radius: 5px;
      cursor: pointer;
      color: rgba(255,255,255,.7);
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.07);
      transition: background .15s ease, color .15s ease, border-color .15s ease;
    }
    .ev-pick-chip--on, .ev-sev-chip--on, .ev-filter-chip--on {
      color: var(--c, #fff);
      background: color-mix(in srgb, var(--c, #3d9eff) 14%, transparent);
      border-color: color-mix(in srgb, var(--c, #3d9eff) 50%, transparent);
    }
    .ev-ico { margin-right: 4px; }

    .ev-history-title {
      font-size: 10px; color: rgba(255,255,255,.5); margin-bottom: 5px;
      letter-spacing: .8px; font-weight: 600;
    }
    .ev-empty { font-size: 11px; color: rgba(255,255,255,.4); padding: 4px 2px; }

    .ev-row {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 0;
      border-top: 1px solid rgba(255,255,255,.05);
    }
    .ev-row:first-of-type { border-top: 0; }
    .ev-row-ico {
      flex: 0 0 18px;
      text-align: center;
      color: var(--c, #fff);
    }
    .ev-row-main { flex: 1 1 auto; min-width: 0; }
    .ev-row-label {
      font-size: 11px; color: rgba(255,255,255,.85);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ev-row-meta {
      font-size: 10px; color: rgba(255,255,255,.45);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ev-row-state {
      font-size: 10px; font-variant-numeric: tabular-nums;
      color: rgba(255,255,255,.75);
    }
    .ev-row-state--gone { color: rgba(46,204,113,.85); }
  `],
})
export class EventsPanelComponent implements OnInit, OnDestroy {

  protected drop = inject(IncidentDropService);
  private layer  = inject(IncidentLayerService);
  private http   = inject(HttpClient);

  /** Polling cadence — 4 s is plenty for a recent-events list. */
  private static readonly POLL_MS = 4000;

  // Type metadata — colours match the live overlay's ramp.
  protected readonly TYPES: ReadonlyArray<TypeChip & { short: string }> = [
    { type: 'accident',     label: 'Accident',     short: 'Acc',     color: '#e74c3c', icon: '⚠' },
    { type: 'closure',      label: 'Fermeture',    short: 'Ferm',    color: '#e67e22', icon: '⛔' },
    { type: 'congestion',   label: 'Congestion',   short: 'Cong',    color: '#f1c40f', icon: '≋' },
    { type: 'construction', label: 'Travaux',      short: 'Trav',    color: '#3498db', icon: '🛠' },
  ];

  /** Empty set = show all types (no filter). */
  readonly visibleTypes = signal<Set<IncidentType>>(new Set());
  readonly history      = signal<IncidentHistoryEntry[]>([]);
  readonly allVisible   = computed(() => this.visibleTypes().size === 0);

  /** Forces history relative-time labels to refresh once a second. */
  readonly now = signal<number>(Date.now());

  private pollTimer?: ReturnType<typeof setInterval>;
  private clockTimer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.refresh();
    this.pollTimer  = setInterval(() => this.refresh(), EventsPanelComponent.POLL_MS);
    this.clockTimer = setInterval(() => this.now.set(Date.now()), 1000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer)  clearInterval(this.pollTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
  }

  // ── Filter chips ─────────────────────────────────────────────────────────

  showAll(): void {
    this.visibleTypes.set(new Set());
    this.layer.setTypeFilter([]);
  }

  toggleType(t: IncidentType): void {
    const next = new Set(this.visibleTypes());
    if (next.has(t)) next.delete(t); else next.add(t);
    this.visibleTypes.set(next);
    this.layer.setTypeFilter(next);
  }

  // ── Drop UI ──────────────────────────────────────────────────────────────

  setSeverity(s: number): void {
    if (s === 1 || s === 2 || s === 3) this.drop.nextSeverity.set(s);
  }

  // ── History rendering ────────────────────────────────────────────────────

  colorFor(t: IncidentType): string {
    return this.TYPES.find(c => c.type === t)?.color ?? '#aaaaaa';
  }

  iconFor(t: IncidentType): string {
    return this.TYPES.find(c => c.type === t)?.icon ?? '•';
  }

  isExpired(h: IncidentHistoryEntry): boolean {
    return h.expiresAtMs <= this.now();
  }

  remaining(h: IncidentHistoryEntry): number {
    return Math.max(0, Math.round((h.expiresAtMs - this.now()) / 1000));
  }

  // ── Polling ──────────────────────────────────────────────────────────────

  private refresh(): void {
    this.http.get<IncidentHistoryEntry[]>(
      `${environment.backendUrl}/api/simulation/incidents/history`,
    ).subscribe({
      next: rows => this.history.set((rows ?? []).slice(0, 20)),
      error: () => {},
    });
  }
}
