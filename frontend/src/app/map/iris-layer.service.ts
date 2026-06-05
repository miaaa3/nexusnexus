import { Injectable, OnDestroy, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Map as MapLibreMap } from 'maplibre-gl';
import { environment } from '../../environments/environment';

/**
 * IRIS INSEE zoning overlay.
 *
 * Renders the INSEE IRIS zones (finest French statistical subdivision,
 * ~2 000 inhabitants each) as a choropleth fill layer on the map.
 *
 * Lifecycle:
 *  1. {@link init} — fetches the GeoJSON once from /api/iris/zones,
 *     registers source + layers (fill, outline, label).
 *  2. Polls /api/iris/counts every {@link POLL_MS} and updates each
 *     feature's vehicleCount property so MapLibre re-colours the fill.
 *  3. {@link show} / {@link hide} toggle visibility.
 *
 * Colour ramp (vehicle density per km²):
 *   0  → transparent (empty)
 *   10 → light blue
 *   50 → blue
 *   100+ → deep blue / purple
 *
 * Keyboard shortcut: N (for iNsee)
 */
@Injectable({ providedIn: 'root' })
export class IrisLayerService implements OnDestroy {

  private readonly SOURCE_ID  = 'nexus-iris';
  private readonly FILL_ID    = 'nexus-iris-fill';
  private readonly LINE_ID    = 'nexus-iris-line';
  private readonly HILITE_ID  = 'nexus-iris-highlight';
  private readonly LABEL_ID   = 'nexus-iris-label';
  private readonly POLL_MS    = 3_000;

  private http = inject(HttpClient);
  private map?: MapLibreMap;
  private pollTimer?: ReturnType<typeof setInterval>;
  private visible = false;
  private ready   = false;
  private selectedCodeIris: string | null = null;

  // ── Public API ──────────────────────────────────────────────────────────────

  init(map: MapLibreMap): void {
    this.map = map;
    this.cleanup();
    this.loadZones();
  }

  show(): void {
    this.visible = true;
    if (this.ready) this.setLayerVisibility('visible');
  }

  hide(): void {
    this.visible = false;
    if (this.ready) this.setLayerVisibility('none');
  }

  isReady(): boolean { return this.ready; }

  selectZone(codeIris: string | null): void {
    this.selectedCodeIris = codeIris;
    this.updateHighlightFilter();
  }

  /**
   * Look up the bounding-box centroid for an IRIS code from the cached
   * GeoJSON. Returns null if the IRIS layer hasn't loaded yet or the code
   * isn't in the active set.
   *
   * Used by the dashboard's "Analyse territoriale" card to fly the map to a
   * zone the user clicked.
   */
  getCentroidFor(codeIris: string): { lat: number; lon: number } | null {
    if (!this.map) return null;
    const src = this.map.getSource(this.SOURCE_ID) as any;
    const data = src?._data;
    if (!data?.features) return null;
    for (const feat of data.features) {
      if (feat.properties?.codeIris !== codeIris) continue;
      // GeoJSON Polygon shape: coordinates = [ ring ], ring = [[lon,lat],...]
      const ring = feat.geometry?.coordinates?.[0];
      if (!ring?.length) return null;
      let minLon = +Infinity, maxLon = -Infinity;
      let minLat = +Infinity, maxLat = -Infinity;
      for (const p of ring) {
        if (p[0] < minLon) minLon = p[0];
        if (p[0] > maxLon) maxLon = p[0];
        if (p[1] < minLat) minLat = p[1];
        if (p[1] > maxLat) maxLat = p[1];
      }
      return { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 };
    }
    return null;
  }

  ngOnDestroy(): void { this.cleanup(); }

  // ── Private ─────────────────────────────────────────────────────────────────

  private loadZones(): void {
    this.http.get<any>(`${environment.backendUrl}/api/iris/zones`).subscribe({
      next: geojson => {
        if (!this.map || !geojson?.features?.length) return;
        this.registerSource(geojson);
        this.registerLayers();
        this.ready = true;
        this.setLayerVisibility(this.visible ? 'visible' : 'none');
        this.startPolling();
      },
      error: err => {
        console.warn('[IrisLayer] Could not load IRIS zones:', err.message ?? err);
      },
    });
  }

  private registerSource(geojson: any): void {
    if (!this.map) return;
    if (!this.map.getSource(this.SOURCE_ID)) {
      this.map.addSource(this.SOURCE_ID, { type: 'geojson', data: geojson });
    } else {
      (this.map.getSource(this.SOURCE_ID) as any).setData(geojson);
    }
  }

  private registerLayers(): void {
    const map = this.map!;

    // ── Fill — choropleth by vehicle density ──────────────────────────────────
    if (!map.getLayer(this.FILL_ID)) {
      map.addLayer({
        id:     this.FILL_ID,
        type:   'fill',
        source: this.SOURCE_ID,
        paint: {
          // Choropleth by CONGESTION (speed deficit + incidents), not raw density.
          // Empty zones render transparent so the basemap stays readable.
          'fill-color': [
            'case',
            ['==', ['get', 'vehicleCount'], 0], 'rgba(0,0,0,0)',
            [
              'interpolate', ['linear'],
              ['get', 'congestionScore'],
              0.00, 'rgba(46, 204, 113, 0.22)',  // green — free flow
              0.25, 'rgba(241, 196, 15, 0.30)',  // yellow — moderate
              0.50, 'rgba(230, 126, 34, 0.42)',  // orange — busy
              0.75, 'rgba(231,  76, 60, 0.55)',  // red    — heavy
              1.00, 'rgba(192,  57, 43, 0.70)',  // deep red — gridlock
            ],
          ],
          'fill-opacity': 1,
        },
        layout: { visibility: 'none' },
      });

      // Popup on click — control-tower style analytics card.
      map.on('click', this.FILL_ID, (e: any) => {
        const f = e.features?.[0];
        if (!f) return;
        const {
          nomIris, codeIris, typIris, nomCom, inseeComm,
          vehicleCount, density, avgSpeedKmh, incidentCount, congestionScore,
        } = f.properties;
        this.selectZone(codeIris ?? null);
        const typeLabel: Record<string, string> = {
          H: 'Habitat', A: 'Activité', D: 'Divers', Z: 'Zone spéciale',
        };
        const cs   = Number(congestionScore ?? 0);
        const csPct = Math.round(cs * 100);
        const csColor = cs < 0.25 ? '#2ecc71'
                      : cs < 0.50 ? '#f1c40f'
                      : cs < 0.75 ? '#e67e22'
                      : '#e74c3c';
        const csLabel = cs < 0.25 ? 'fluide'
                      : cs < 0.50 ? 'modéré'
                      : cs < 0.75 ? 'dense'
                      : 'engorgé';
        // ID unique pour pouvoir cibler la sparkline une fois la fetch arrivée
        const sparkId = 'iris-spark-' + codeIris;
        new (window as any).maplibregl.Popup({ className: 'nexus-popup', maxWidth: '320px' })
          .setLngLat(e.lngLat)
          .setHTML(`
            <div style="line-height:1.55">
              <b style="font-size:13px">${nomIris}</b><br>
              <span style="opacity:.7;font-size:11px">Code IRIS : ${codeIris}</span><br>
              <span style="opacity:.7;font-size:11px">Commune : ${nomCom} (${inseeComm})</span><br>
              <span style="opacity:.7;font-size:11px">Type : ${typeLabel[typIris] ?? typIris}</span>
              <hr style="margin:6px 0;opacity:.2">
              <span style="font-size:12px">🚗 <b>${vehicleCount}</b> véh.</span>
              &nbsp;·&nbsp;
              <span style="font-size:12px">⚠️ <b>${incidentCount ?? 0}</b> incident${(incidentCount ?? 0) !== 1 ? 's' : ''}</span><br>
              <span style="font-size:11px;opacity:.75">Vitesse moy. : <b>${avgSpeedKmh ?? 0}</b> km/h</span><br>
              <span style="font-size:11px;opacity:.75">Densité : ${density} veh/km²</span><br>
              <div style="margin-top:6px;font-size:11px">
                Congestion :
                <span style="color:${csColor};font-weight:600">${csLabel}</span>
                <span style="opacity:.65">(${csPct}%)</span>
              </div>
              <div style="height:4px;border-radius:2px;background:rgba(255,255,255,.08);overflow:hidden;margin-top:3px">
                <div style="height:100%;width:${csPct}%;background:${csColor}"></div>
              </div>
              <hr style="margin:8px 0 6px;opacity:.2">
              <div style="font-size:10px;opacity:.65;letter-spacing:.6px;margin-bottom:2px">
                HISTORIQUE 1 H
              </div>
              <div id="${sparkId}" style="height:42px">
                <span style="font-size:10.5px;opacity:.5">chargement…</span>
              </div>
            </div>
          `)
          .addTo(map);
        // Fetch + injection sparkline async (non bloquant pour l'ouverture du popup).
        this.fetchAndDrawSparkline(codeIris, sparkId);
      });
      map.on('mouseenter', this.FILL_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', this.FILL_ID, () => { map.getCanvas().style.cursor = 'crosshair'; });
    }

    // ── Outline — bordures colorées par TYPE d'IRIS (H/A/D/Z) ───────────────
    // Le fond (fill) reste coloré par congestion, la bordure par type :
    //   H = Habitat       → bleu       (zones résidentielles)
    //   A = Activité      → orange     (zones commerciales / industrielles)
    //   D = Divers        → violet     (zones mixtes)
    //   Z = Zone spéciale → vert       (parcs, gares, équipements)
    // Bordures toujours visibles (même quand la zone est vide / fluide).
    if (!map.getLayer(this.LINE_ID)) {
      map.addLayer({
        id:     this.LINE_ID,
        type:   'line',
        source: this.SOURCE_ID,
        paint: {
          'line-color': [
            'match', ['get', 'typIris'],
            'H', 'rgba(61, 158, 255, 0.95)',   // bleu — habitat
            'A', 'rgba(230, 126,  34, 0.95)',  // orange — activité
            'D', 'rgba(155,  89, 182, 0.95)',  // violet — divers
            'Z', 'rgba( 46, 204, 113, 0.95)',  // vert — zone spéciale
            /* défaut */ 'rgba(160, 180, 200, 0.80)',
          ],
          'line-opacity': 0.92,
          'line-width': [
            'interpolate', ['linear'],
            ['zoom'],
            10, 0.9,
            13, 1.6,
            16, 2.6,
          ],
          'line-blur': 0.10,
        },
        layout: {
          visibility: 'none',
          'line-join': 'round',
          'line-cap':  'round',
        },
      });
    }

    // ── Selected IRIS highlight ──────────────────────────────────────────────
    if (!map.getLayer(this.HILITE_ID)) {
      map.addLayer({
        id:     this.HILITE_ID,
        type:   'line',
        source: this.SOURCE_ID,
        filter: ['==', ['get', 'codeIris'], this.selectedCodeIris ?? ''],
        paint: {
          'line-color': 'rgba(255,255,255,0.95)',
          'line-width': [
            'interpolate', ['linear'],
            ['zoom'],
            10, 2.2,
            13, 3.4,
            16, 5.0,
          ],
          'line-opacity': 0.98,
          'line-blur': 0.25,
        },
        layout: { visibility: 'none' },
      });
    }

    // ── Labels (only at high zoom) ────────────────────────────────────────────
    if (!map.getLayer(this.LABEL_ID)) {
      map.addLayer({
        id:     this.LABEL_ID,
        type:   'symbol',
        source: this.SOURCE_ID,
        minzoom: 13,
        layout: {
          'text-field': ['concat', ['get', 'nomIris'], '\n', ['to-string', ['get', 'vehicleCount']], ' veh'],
          'text-size': 9,
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-anchor': 'center',
          'visibility': 'none',
        },
        paint: {
          'text-color': 'rgba(200,220,255,0.9)',
          'text-halo-color': 'rgba(0,0,20,0.7)',
          'text-halo-width': 1,
        },
      });
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.refreshCounts(), this.POLL_MS);
  }

  /**
   * Fetch lightweight counts and update each feature's vehicleCount + density
   * so MapLibre automatically re-evaluates the choropleth expression.
   */
  /**
   * Récupère l'historique de congestion 1 h d'une zone et dessine une
   * sparkline SVG dans l'élément {@code #containerId} du popup.
   *
   * Le rendu utilise un polyline SVG simple, sans librairie de charts.
   * Couleurs interpolées : vert (0%) → rouge (100%).
   */
  private fetchAndDrawSparkline(codeIris: string, containerId: string): void {
    this.http.get<{ codeIris: string; points: number[] }>(
      `${environment.backendUrl}/api/iris/${codeIris}/history`
    ).subscribe({
      next: data => {
        const el = document.getElementById(containerId);
        if (!el) return;       // popup déjà fermé
        const pts = data?.points ?? [];
        if (pts.length === 0) {
          el.innerHTML =
            `<span style="font-size:10.5px;opacity:.5">` +
            `Données insuffisantes (vient juste d'être chargé).</span>`;
          return;
        }
        el.innerHTML = this.buildSparklineSVG(pts);
      },
      error: () => {
        const el = document.getElementById(containerId);
        if (el) el.innerHTML =
          `<span style="font-size:10.5px;opacity:.5">Historique indisponible.</span>`;
      },
    });
  }

  /** Construit un SVG sparkline à partir d'un tableau de scores [0..1]. */
  private buildSparklineSVG(points: number[]): string {
    const W = 280;
    const H = 42;
    const PAD = 4;
    const n  = points.length;
    if (n === 0) return '';

    const stepX = (W - 2 * PAD) / Math.max(n - 1, 1);
    // Convertit chaque score en coord SVG (origine en haut à gauche → on inverse Y)
    const xy = points.map((v, i) => {
      const clamped = Math.max(0, Math.min(1, v));
      return [
        PAD + i * stepX,
        H - PAD - clamped * (H - 2 * PAD),
      ];
    });

    // Polyline pour la ligne
    const linePts = xy.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    // Polygone pour l'aire en dessous (effet glow + fill dégradé)
    const areaPts = `${PAD},${H - PAD} ${linePts} ${(W - PAD).toFixed(1)},${H - PAD}`;

    // Dernier point + indicateur
    const last = xy[n - 1];
    const lastScore = points[n - 1];
    const lastColor = lastScore < 0.25 ? '#2ecc71'
                    : lastScore < 0.50 ? '#f1c40f'
                    : lastScore < 0.75 ? '#e67e22'
                    : '#e74c3c';
    // Tendance : compare le dernier au plus ancien
    const trend = lastScore - points[0];
    const trendArrow = trend >  0.05 ? '▲'
                     : trend < -0.05 ? '▼'
                     : '→';
    const trendColor = trend >  0.05 ? '#e74c3c'
                     : trend < -0.05 ? '#2ecc71'
                     : '#94a3b8';

    return `
      <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}"
           preserveAspectRatio="none"
           style="display:block">
        <defs>
          <linearGradient id="sg-${Date.now()}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stop-color="${lastColor}" stop-opacity="0.38"/>
            <stop offset="100%" stop-color="${lastColor}" stop-opacity="0.04"/>
          </linearGradient>
        </defs>
        <polygon points="${areaPts}" fill="url(#sg-${Date.now()})"/>
        <polyline points="${linePts}"
                  fill="none"
                  stroke="${lastColor}"
                  stroke-width="1.6"
                  stroke-linejoin="round"
                  stroke-linecap="round"/>
        <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}"
                r="2.6" fill="${lastColor}" stroke="#0a0e1a" stroke-width="0.8"/>
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:9.5px;
                  opacity:.7;margin-top:2px">
        <span>il y a ${n} min</span>
        <span><span style="color:${trendColor}">${trendArrow}</span>
              tendance ${trend > 0 ? '+' : ''}${Math.round(trend * 100)} %</span>
        <span>maintenant</span>
      </div>
    `;
  }

  private refreshCounts(): void {
    if (!this.map || !this.visible) return;
    this.http.get<Record<string, {
      count: number; density: number;
      avgSpeedKmh: number; incidentCount: number; congestionScore: number;
    }>>(`${environment.backendUrl}/api/iris/counts`).subscribe({
      next: counts => {
        const src = this.map?.getSource(this.SOURCE_ID) as any;
        if (!src?._data) return;
        // Mutate feature properties in the cached GeoJSON, then call setData
        // so MapLibre re-evaluates the choropleth + label expressions.
        const data = src._data as any;
        let changed = false;
        for (const feat of data.features ?? []) {
          const code = feat.properties?.codeIris;
          if (!code) continue;
          const u = counts[code];
          if (u) {
            feat.properties.vehicleCount    = u.count;
            feat.properties.density         = u.density;
            feat.properties.avgSpeedKmh     = u.avgSpeedKmh;
            feat.properties.incidentCount   = u.incidentCount;
            feat.properties.congestionScore = u.congestionScore;
            changed = true;
          }
        }
        if (changed) src.setData(data);
      },
      error: () => {},
    });
  }

  private setLayerVisibility(v: 'visible' | 'none'): void {
    if (!this.map) return;
    for (const id of [this.FILL_ID, this.LINE_ID, this.HILITE_ID, this.LABEL_ID]) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, 'visibility', v);
      }
    }
  }

  private updateHighlightFilter(): void {
    if (!this.map?.getLayer(this.HILITE_ID)) return;
    this.map.setFilter(this.HILITE_ID, ['==', ['get', 'codeIris'], this.selectedCodeIris ?? '']);
    this.map.setLayoutProperty(this.HILITE_ID, 'visibility', this.visible && this.selectedCodeIris ? 'visible' : 'none');
  }

  private cleanup(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
