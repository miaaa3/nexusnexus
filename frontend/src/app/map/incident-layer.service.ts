import { Injectable, OnDestroy, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Map as MapLibreMap } from 'maplibre-gl';

import { environment } from '../../environments/environment';

/**
 * Incident types shown on the map.
 * Today only "accident" is emitted by the backend — the type field stays open
 * so future real sources (closures, congestion clusters, construction) can be
 * added without touching the rendering code.
 */
export type IncidentType = 'accident' | 'closure' | 'congestion' | 'construction';

/** Wire-format incident from GET /api/simulation/events. */
interface IncidentUpdate {
  id: string;
  type: IncidentType;
  severity: number;
  lat: number;
  lon: number;
  label: string;
  expiresAtMs: number;
}

/** Colour per incident type. */
const INCIDENT_COLORS: Record<IncidentType, string> = {
  accident:     '#e74c3c',
  closure:      '#e67e22',
  congestion:   '#f1c40f',
  construction: '#3498db',
};

/**
 * IncidentLayerService
 *
 * Renders live events from the backend as GPU-accelerated MapLibre circles.
 * No mock data — every dot on this layer corresponds to a real wreck in the
 * running simulation (sourced from {@code AccidentSystem} via
 * {@code GET /api/simulation/events}).
 *
 * Lifecycle: {@link init} is idempotent across MapLibre style switches — it
 * tears down any previous poll and re-registers the source/layer.
 */
@Injectable({ providedIn: 'root' })
export class IncidentLayerService implements OnDestroy {

  private readonly SOURCE_ID = 'nexus-incidents';
  private readonly LAYER_ID  = 'nexus-incidents-circles';
  private readonly POLL_MS   = 1500;

  private http = inject(HttpClient);
  private map?: MapLibreMap;
  private pollTimer?: ReturnType<typeof setInterval>;
  private visible = false;
  private cached: IncidentUpdate[] = [];
  /** Active type filter — empty set means "show all". */
  private typeFilter = new Set<IncidentType>();

  init(map: MapLibreMap): void {
    this.map = map;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (!map.getSource(this.SOURCE_ID)) {
      map.addSource(this.SOURCE_ID, {
        type: 'geojson',
        data: this.toGeoJson(this.cached),
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
            10, ['*', 4, ['get', 'severity']],
            14, ['*', 7, ['get', 'severity']],
          ],
          'circle-color': [
            'match', ['get', 'type'],
            'accident',     INCIDENT_COLORS.accident,
            'closure',      INCIDENT_COLORS.closure,
            'congestion',   INCIDENT_COLORS.congestion,
            'construction', INCIDENT_COLORS.construction,
            '#aaaaaa',
          ],
          'circle-opacity': 0.9,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-opacity': 0.45,
          'circle-blur': 0.2,
        },
        layout: { visibility: 'none' },
      });

      // Popup on click — shows the live label + ETA-to-clear (countdown).
      map.on('click', this.LAYER_ID, (e: any) => {
        const f = e.features?.[0];
        if (!f) return;
        const { label, type, expiresAtMs } = f.properties;
        const remainingS = Math.max(0, Math.round((expiresAtMs - Date.now()) / 1000));
        new (window as any).maplibregl.Popup({ closeButton: false, className: 'nexus-popup' })
          .setLngLat(e.lngLat)
          .setHTML(`<b>${String(type).toUpperCase()}</b><br>${label}<br><i>clears in ${remainingS}s</i>`)
          .addTo(map);
      });
      map.on('mouseenter', this.LAYER_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', this.LAYER_ID, () => { map.getCanvas().style.cursor = 'crosshair'; });
    }

    // Restore visibility across style switches.
    map.setLayoutProperty(this.LAYER_ID, 'visibility', this.visible ? 'visible' : 'none');

    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), this.POLL_MS);
  }

  show(): void {
    this.visible = true;
    this.map?.setLayoutProperty(this.LAYER_ID, 'visibility', 'visible');
    this.refresh();   // immediate first paint instead of waiting for the next poll
  }
  hide(): void {
    this.visible = false;
    this.map?.setLayoutProperty(this.LAYER_ID, 'visibility', 'none');
  }

  /** Most recent count of live events — handy for the dashboard badge. */
  count(): number { return this.cached.length; }

  /**
   * Restrict which incident types appear on the overlay. Pass an empty set
   * (or no argument) to show all types again. The source data is unchanged —
   * we just rebuild the GeoJSON filtered.
   */
  setTypeFilter(types: Iterable<IncidentType> = []): void {
    this.typeFilter = new Set(types);
    if (this.map) {
      const src = this.map.getSource(this.SOURCE_ID) as { setData?: (d: any) => void } | undefined;
      src?.setData?.(this.toGeoJson(this.filtered(this.cached)));
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private refresh(): void {
    if (!this.map) return;
    // Skip the network + setData when the overlay is hidden — saves ~1 REST
    // hit + GeoJSON reparse per second per hidden layer.
    if (!this.visible) return;
    this.http.get<IncidentUpdate[]>(`${environment.backendUrl}/api/simulation/events`)
      .subscribe({
        next: events => {
          this.cached = events ?? [];
          const src = this.map?.getSource(this.SOURCE_ID) as { setData?: (d: any) => void } | undefined;
          src?.setData?.(this.toGeoJson(this.filtered(this.cached)));
        },
        error: () => {},   // backend warming up; next tick retries
      });
  }

  /** Apply the active type filter without copying when no filter is set. */
  private filtered(events: IncidentUpdate[]): IncidentUpdate[] {
    if (this.typeFilter.size === 0) return events;
    return events.filter(e => this.typeFilter.has(e.type));
  }

  private toGeoJson(events: IncidentUpdate[]): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: events.map(e => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
        properties: {
          id:          e.id,
          type:        e.type,
          severity:    e.severity,
          label:       e.label,
          expiresAtMs: e.expiresAtMs,
        },
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
