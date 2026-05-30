import { Injectable, OnDestroy, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Map as MapLibreMap } from 'maplibre-gl';

import { environment } from '../../environments/environment';

interface LightUpdate {
  lat: number;
  lon: number;
  red: boolean;
}

/**
 * Traffic-light layer.
 *
 * One small circle per signalized intersection, coloured by the current red /
 * green state. Lights are static (positions never change) and cycle slowly
 * (~16 s), so we poll a REST snapshot every second instead of streaming them
 * over the high-rate vehicle WebSocket — keeps the frame payload lean and
 * avoids any replay-format change.
 *
 * Lifecycle:
 *  - {@link #init} is idempotent across MapLibre style switches: it tears
 *    down any previous poll, re-adds the GeoJSON source + layer (the style
 *    swap wipes them), and starts a fresh interval.
 */
@Injectable({ providedIn: 'root' })
export class TrafficLightLayerService implements OnDestroy {

  private readonly SOURCE_ID = 'nexus-traffic-lights';
  private readonly LAYER_ID  = 'nexus-traffic-lights-circles';
  private readonly HALO_ID   = 'nexus-traffic-lights-halo';
  private readonly POLL_MS   = 1000;

  private http = inject(HttpClient);
  private map?: MapLibreMap;
  private pollTimer?: ReturnType<typeof setInterval>;
  /** Last payload received — re-applied immediately after a style switch. */
  private cached: LightUpdate[] = [];

  init(map: MapLibreMap): void {
    this.map = map;

    // Tear down any previous polling — init() is called again after every style switch.
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (!map.getSource(this.SOURCE_ID)) {
      map.addSource(this.SOURCE_ID, {
        type: 'geojson',
        data: this.geojson(this.cached),
      });
    }
    // Soft halo behind the core — sized roughly 3× the core so the signal is
    // unmistakable next to a vehicle blob even at city-wide zooms.
    if (!map.getLayer(this.HALO_ID)) {
      map.addLayer({
        id: this.HALO_ID,
        type: 'circle',
        source: this.SOURCE_ID,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            10, 7,
            14, 14,
            17, 22,
          ],
          'circle-color': [
            'case', ['boolean', ['get', 'red'], false],
            '#ff3b30',
            '#34d399',
          ],
          'circle-opacity': 0.22,
          'circle-blur': 0.9,
        },
      });
    }
    if (!map.getLayer(this.LAYER_ID)) {
      map.addLayer({
        id: this.LAYER_ID,
        type: 'circle',
        source: this.SOURCE_ID,
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            10, 4.5,
            14, 7.0,
            17, 11.0,
          ],
          'circle-color': [
            'case', ['boolean', ['get', 'red'], false],
            '#ff3b30',   // red
            '#34d399',   // green
          ],
          'circle-opacity': 1.0,
          'circle-stroke-width': 1.8,
          'circle-stroke-color': '#0b1220',
          'circle-stroke-opacity': 0.95,
        },
      });
    }

    // One immediate refresh, then poll. The 16 s cycle ≫ 1 s, so colour changes are smooth.
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), this.POLL_MS);
  }

  private refresh(): void {
    if (!this.map) return;
    this.http.get<LightUpdate[]>(`${environment.backendUrl}/api/simulation/lights`)
      .subscribe({
        next: lights => {
          this.cached = lights ?? [];
          const src = this.map?.getSource(this.SOURCE_ID) as { setData?: (d: any) => void } | undefined;
          src?.setData?.(this.geojson(this.cached));
        },
        // Silent on error — backend may still be warming up, next tick will retry.
        error: () => {},
      });
  }

  private geojson(lights: LightUpdate[]): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: lights.map(l => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
        properties: { red: l.red },
      })),
    };
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
