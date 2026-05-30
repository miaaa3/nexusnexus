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
  private readonly LABEL_ID   = 'nexus-iris-label';
  private readonly POLL_MS    = 3_000;

  private http = inject(HttpClient);
  private map?: MapLibreMap;
  private pollTimer?: ReturnType<typeof setInterval>;
  private visible = false;
  private ready   = false;

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
        new (window as any).maplibregl.Popup({ className: 'nexus-popup', maxWidth: '300px' })
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
            </div>
          `)
          .addTo(map);
      });
      map.on('mouseenter', this.FILL_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', this.FILL_ID, () => { map.getCanvas().style.cursor = 'crosshair'; });
    }

    // ── Outline ───────────────────────────────────────────────────────────────
    if (!map.getLayer(this.LINE_ID)) {
      map.addLayer({
        id:     this.LINE_ID,
        type:   'line',
        source: this.SOURCE_ID,
        paint: {
          'line-color': 'rgba(80,160,255,0.35)',
          'line-width': 0.7,
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
    for (const id of [this.FILL_ID, this.LINE_ID, this.LABEL_ID]) {
      if (this.map.getLayer(id)) {
        this.map.setLayoutProperty(id, 'visibility', v);
      }
    }
  }

  private cleanup(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
