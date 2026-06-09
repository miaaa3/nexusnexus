import {
  Component, OnInit, OnDestroy, EventEmitter, Output, inject, signal, effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { environment } from '../../environments/environment';
import { IrisLayerService } from '../map/iris-layer.service';

/** Row shape returned by GET /api/iris/top-congested. */
interface IrisCongestionRow {
  codeIris:        string;
  nomIris:         string;
  nomCom:          string;
  vehicleCount:    number;
  avgSpeedKmh:     number;
  incidentCount:   number;
  congestionScore: number;   // 0..1
}

/** Lat/lon target emitted to the dashboard for a map fly-to. */
export interface IrisFlyToEvent {
  lat: number;
  lon: number;
  codeIris: string;
}

/**
 * "Analyse territoriale" card — top-5 most congested INSEE IRIS zones, refreshed
 * every {@link POLL_MS}. Click a row to fly the map to that zone's centroid.
 *
 * Performance: at most 5 rows, no per-vehicle work, polls REST not WS.
 * Idle when the backend hasn't finished loading IRIS yet.
 */
@Component({
  selector: 'app-iris-analytics',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="iris-card">
      @if (selected(); as z) {
        <!-- ── Selected zone detail (sidebar replacement for the old popup) ── -->
        <div class="iris-detail">
          <div class="iris-detail-head">
            <div>
              <div class="iris-detail-name">{{ z.nomIris }}</div>
              <div class="iris-detail-sub">
                {{ z.nomCom }} · {{ z.codeIris }} · {{ typeLabel(z.typIris) }}
              </div>
            </div>
            <button class="iris-close" (click)="clearSelection()" title="Fermer">×</button>
          </div>

          <div class="iris-detail-grid">
            <div><span class="d-val">{{ z.vehicleCount | number }}</span><span class="d-lbl">véhicules</span></div>
            <div><span class="d-val" [style.color]="z.incidentCount > 0 ? '#ff8c66' : ''">{{ z.incidentCount }}</span><span class="d-lbl">incidents</span></div>
            <div><span class="d-val">{{ z.avgSpeedKmh | number:'1.0-1' }}</span><span class="d-lbl">km/h moy</span></div>
            <div><span class="d-val">{{ z.density | number:'1.0-1' }}</span><span class="d-lbl">véh/km²</span></div>
          </div>

          <div class="iris-detail-row">
            <span>Congestion</span>
            <span [style.color]="colorFor(z.congestionScore)" style="font-weight:600">
              {{ congestionLabel(z.congestionScore) }}
              ({{ (z.congestionScore * 100) | number:'1.0-0' }}%)
            </span>
          </div>
          <div class="iris-bar">
            <div class="iris-bar-fill"
                 [style.width.%]="z.congestionScore * 100"
                 [style.background]="colorFor(z.congestionScore)"></div>
          </div>

          <div class="iris-detail-spark-label">HISTORIQUE 1 H</div>
          <div class="iris-detail-spark">
            @if (sparklineSvg()) {
              <div [innerHTML]="sparklineSvg()"></div>
            } @else {
              <span class="iris-empty" style="padding:0">{{ sparklineMsg() }}</span>
            }
          </div>
        </div>
        <div class="iris-detail-sep"></div>
      }

      <div class="iris-header">
        <span class="iris-title">ANALYSE TERRITORIALE</span>
        <span class="iris-sub">Top {{ rows().length || 5 }} · congestion</span>
      </div>

      @if (status().loaded) {
        <div class="iris-summary">
          <div class="iris-stat">
            <div class="iris-stat-val">{{ status().zoneCount }}</div>
            <div class="iris-stat-lbl">IRIS</div>
          </div>
          <div class="iris-stat">
            <div class="iris-stat-val" style="color:#3d9eff">{{ status().active }}</div>
            <div class="iris-stat-lbl">actifs</div>
          </div>
          <div class="iris-stat">
            <div class="iris-stat-val" style="color:#e67e22">{{ status().trouble }}</div>
            <div class="iris-stat-lbl">chargés</div>
          </div>
          <div class="iris-stat">
            <div class="iris-stat-val" style="color:#e74c3c">{{ status().heavy }}</div>
            <div class="iris-stat-lbl">engorgés</div>
          </div>
        </div>
      } @else {
        <div class="iris-empty">IRIS pas encore chargé.</div>
      }

      @if (loading() && !rows().length) {
        <div class="iris-empty">Chargement…</div>
      } @else if (!rows().length) {
        <div class="iris-empty">Aucun IRIS encombré pour l'instant.</div>
      } @else {
        <div class="iris-list">
          @for (r of rows(); track r.codeIris; let i = $index) {
            <button class="iris-row" (click)="onRowClick(r)" [title]="r.codeIris">
              <span class="iris-rank">{{ i + 1 }}</span>
              <div class="iris-main">
                <div class="iris-name">{{ r.nomIris }}</div>
                <div class="iris-meta">
                  {{ r.nomCom }} ·
                  {{ r.vehicleCount | number }} véh ·
                  {{ r.avgSpeedKmh | number:'1.0-1' }} km/h
                  @if (r.incidentCount > 0) {
                    · <span class="iris-inc">⚠ {{ r.incidentCount }}</span>
                  }
                </div>
                <div class="iris-bar">
                  <div class="iris-bar-fill"
                       [style.width.%]="r.congestionScore * 100"
                       [style.background]="colorFor(r.congestionScore)"></div>
                </div>
              </div>
              <span class="iris-pct" [style.color]="colorFor(r.congestionScore)">
                {{ (r.congestionScore * 100) | number:'1.0-0' }}%
              </span>
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .iris-card {
      display: flex; flex-direction: column; gap: 8px;
    }
    .iris-header {
      display: flex; justify-content: space-between; align-items: baseline;
    }
    .iris-title {
      font-size: 10px; font-weight: 700; letter-spacing: 1.4px;
      color: rgba(255,255,255,.85);
    }
    .iris-sub {
      font-size: 10px; color: rgba(255,255,255,.45);
    }
    .iris-empty {
      font-size: 11px; color: rgba(255,255,255,.4);
      padding: 6px 4px;
    }

    .iris-summary {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 5px;
      padding: 7px 8px;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.06);
      border-radius: 7px;
    }
    .iris-stat {
      display: flex; flex-direction: column; align-items: center;
      gap: 1px;
    }
    .iris-stat-val {
      font-size: 15px; font-weight: 700;
      color: rgba(255,255,255,.92);
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }
    .iris-stat-lbl {
      font-size: 9px;
      letter-spacing: .8px;
      color: rgba(255,255,255,.5);
      text-transform: uppercase;
    }

    .iris-list {
      display: flex; flex-direction: column; gap: 4px;
    }

    .iris-row {
      display: flex; align-items: center; gap: 9px;
      padding: 7px 8px;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.05);
      border-radius: 7px;
      cursor: pointer;
      transition: background .15s ease, border-color .15s ease;
      text-align: left;
      color: inherit;
      font: inherit;
    }
    .iris-row:hover {
      background: rgba(61,158,255,.08);
      border-color: rgba(61,158,255,.25);
    }

    .iris-rank {
      flex: 0 0 18px;
      font-size: 11px;
      font-weight: 600;
      color: rgba(255,255,255,.45);
      text-align: center;
    }

    .iris-main { flex: 1 1 auto; min-width: 0; }
    .iris-name {
      font-size: 11.5px; font-weight: 500;
      color: rgba(255,255,255,.9);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .iris-meta {
      font-size: 10px;
      color: rgba(255,255,255,.5);
      margin-top: 1px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .iris-inc { color: #ff8c66; font-weight: 500; }

    .iris-bar {
      margin-top: 4px;
      height: 3px;
      border-radius: 2px;
      background: rgba(255,255,255,.06);
      overflow: hidden;
    }
    .iris-bar-fill {
      height: 100%;
      transition: width .25s ease;
    }

    .iris-pct {
      flex: 0 0 38px;
      text-align: right;
      font-size: 11.5px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }

    /* ── Selected-zone detail card ───────────────────────────────────────── */
    .iris-detail {
      display: flex; flex-direction: column; gap: 7px;
      padding: 9px 10px;
      background: linear-gradient(180deg, rgba(61,158,255,.08), rgba(61,158,255,.02));
      border: 1px solid rgba(61,158,255,.3);
      border-radius: 8px;
    }
    .iris-detail-sep {
      height: 1px; background: rgba(255,255,255,.07); margin: 4px 0 2px;
    }
    .iris-detail-head {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 8px;
    }
    .iris-detail-name {
      font-size: 13px; font-weight: 700;
      color: rgba(255,255,255,.95);
      overflow: hidden; text-overflow: ellipsis;
    }
    .iris-detail-sub {
      font-size: 10px;
      color: rgba(255,255,255,.5);
      margin-top: 2px;
    }
    .iris-close {
      flex: 0 0 22px; width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 50%;
      color: rgba(255,255,255,.65);
      cursor: pointer;
      font-size: 15px; line-height: 1;
      transition: all .15s ease;
    }
    .iris-close:hover {
      background: rgba(231,76,60,.18);
      border-color: rgba(231,76,60,.5);
      color: #ff8a7c;
    }
    .iris-detail-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 4px;
      margin-top: 2px;
    }
    .iris-detail-grid > div {
      display: flex; align-items: baseline; gap: 5px;
      padding: 4px 6px;
      background: rgba(255,255,255,.03);
      border-radius: 5px;
    }
    .d-val {
      font-size: 14px; font-weight: 700;
      color: rgba(255,255,255,.92);
      font-variant-numeric: tabular-nums;
    }
    .d-lbl {
      font-size: 10px;
      color: rgba(255,255,255,.5);
    }
    .iris-detail-row {
      display: flex; justify-content: space-between;
      font-size: 11px;
      color: rgba(255,255,255,.75);
      margin-top: 2px;
    }
    .iris-detail-spark-label {
      font-size: 9px; letter-spacing: 1.2px;
      color: rgba(255,255,255,.5);
      margin-top: 4px;
    }
    .iris-detail-spark {
      min-height: 42px;
    }
  `],
})
export class IrisAnalyticsComponent implements OnInit, OnDestroy {

  /** Refresh cadence — 3 s matches the IRIS layer's choropleth polling. */
  private static readonly POLL_MS = 3000;
  /** Top-K to request from the backend. */
  private static readonly LIMIT   = 5;

  private http      = inject(HttpClient);
  private iris      = inject(IrisLayerService);
  private sanitizer = inject(DomSanitizer);

  readonly rows    = signal<IrisCongestionRow[]>([]);
  readonly loading = signal<boolean>(true);

  /** Compteurs agrégés du panneau (header). */
  readonly status = signal<{
    loaded: boolean; zoneCount: number; active: number; trouble: number; heavy: number;
  }>({ loaded: false, zoneCount: 0, active: 0, trouble: 0, heavy: 0 });

  /** Zone IRIS actuellement sélectionnée (signal du service map). */
  readonly selected = this.iris.selectedZone;

  /** Sparkline SVG (sanitisée) chargée à la sélection. */
  readonly sparklineSvg = signal<SafeHtml | null>(null);
  /** Message d'état quand pas de sparkline (chargement / vide / erreur). */
  readonly sparklineMsg = signal<string>('Chargement…');

  @Output() flyTo = new EventEmitter<IrisFlyToEvent>();

  private pollTimer?: ReturnType<typeof setInterval>;

  constructor() {
    // Auto-fetch the 1 h congestion history whenever the selected zone
    // changes — including when the user closes (selected = null) so we
    // wipe the previous sparkline instead of leaving stale data on screen.
    effect(() => {
      const z = this.selected();
      this.sparklineSvg.set(null);
      if (!z) return;
      this.sparklineMsg.set('Chargement…');
      this.iris.fetchHistory(z.codeIris).subscribe({
        next: data => {
          // The user might have already closed or selected another zone
          // before our HTTP came back — drop the result in that case.
          if (this.selected()?.codeIris !== z.codeIris) return;
          const pts = data?.points ?? [];
          if (pts.length === 0) {
            this.sparklineMsg.set("Données insuffisantes (vient juste d'être chargé).");
            return;
          }
          this.sparklineSvg.set(
            this.sanitizer.bypassSecurityTrustHtml(this.iris.buildSparklineSVG(pts)),
          );
        },
        error: () => this.sparklineMsg.set('Historique indisponible.'),
      });
    });
  }

  ngOnInit(): void {
    this.refresh();
    this.refreshStatus();
    this.pollTimer = setInterval(() => {
      this.refresh();
      this.refreshStatus();
    }, IrisAnalyticsComponent.POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  onRowClick(r: IrisCongestionRow): void {
    const c = this.iris.getCentroidFor(r.codeIris);
    if (!c) return;   // IRIS layer not loaded yet — silently no-op
    this.flyTo.emit({ ...c, codeIris: r.codeIris });
  }

  clearSelection(): void {
    this.iris.clearSelection();
  }

  /** Map H/A/D/Z → user-friendly French label. */
  typeLabel(t: string): string {
    return ({ H: 'Habitat', A: 'Activité', D: 'Divers', Z: 'Zone spéciale' } as Record<string, string>)[t] ?? t;
  }

  /** Congestion bucket label aligned with the color ramp. */
  congestionLabel(score: number): string {
    if (score < 0.25) return 'fluide';
    if (score < 0.50) return 'modéré';
    if (score < 0.75) return 'dense';
    return 'engorgé';
  }

  /** Green → yellow → orange → red congestion ramp (matches the choropleth). */
  colorFor(score: number): string {
    if (score < 0.25) return '#2ecc71';
    if (score < 0.50) return '#f1c40f';
    if (score < 0.75) return '#e67e22';
    return '#e74c3c';
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private refresh(): void {
    this.http.get<IrisCongestionRow[]>(
      `${environment.backendUrl}/api/iris/top-congested?limit=${IrisAnalyticsComponent.LIMIT}`
    ).subscribe({
      next: rows => {
        this.rows.set(rows ?? []);
        this.loading.set(false);
      },
      error: () => {
        // Backend still warming up / IRIS not yet loaded — keep last good list.
        this.loading.set(false);
      },
    });
  }

  /** Récupère les compteurs agrégés pour le header. */
  private refreshStatus(): void {
    this.http.get<{
      loaded: boolean; zoneCount: number; active: number; trouble: number; heavy: number;
    }>(`${environment.backendUrl}/api/iris/status`).subscribe({
      next: s => this.status.set(s ?? this.status()),
      error: () => {},
    });
  }
}
