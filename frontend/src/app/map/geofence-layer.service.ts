import { Injectable, OnDestroy, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Map as MapLibreMap } from 'maplibre-gl';

import { environment } from '../../environments/environment';

/** Wire-format zone from GET /api/simulation/zones. */
interface ZoneStatus {
  id:    string;
  name:  string;
  color: string;
  /** Outer ring as [lon, lat] pairs (open — closing vertex added on render). */
  polygon: [number, number][];
  vehiclesInside: number;
  asOfMs: number;
}

/**
 * GeofenceLayerService
 *
 * Real geofences. The backend (ZoneSystem) owns the polygons and counts how
 * many simulated vehicles are currently inside each one; we render the
 * polygons and show "Zone Name (live count)" in the label.
 *
 * Rendering: 3 MapLibre layers off a single GeoJSON source — fill, outline,
 * symbol label. GPU-accelerated, no DOM elements.
 *
 * Lifecycle: {@link init} is idempotent across MapLibre style switches.
 */
@Injectable({ providedIn: 'root' })
export class GeofenceLayerService implements OnDestroy {

  private readonly SOURCE_ID    = 'nexus-geofences';
  private readonly FILL_LAYER   = 'nexus-geofences-fill';
  private readonly OUTLINE_LAYER = 'nexus-geofences-outline';
  private readonly LABEL_LAYER  = 'nexus-geofences-labels';
  private readonly POLL_MS      = 1500;

  private http = inject(HttpClient);
  private map?: MapLibreMap;
  private pollTimer?: ReturnType<typeof setInterval>;
  private visible = false;
  private cached: ZoneStatus[] = [];

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
    if (!map.getLayer(this.FILL_LAYER)) {
      map.addLayer({
        id: this.FILL_LAYER,
        type: 'fill',
        source: this.SOURCE_ID,
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': 0.10,
        },
        layout: { visibility: 'none' },
      });
    }
    if (!map.getLayer(this.OUTLINE_LAYER)) {
      map.addLayer({
        id: this.OUTLINE_LAYER,
        type: 'line',
        source: this.SOURCE_ID,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2,
          'line-opacity': 0.75,
          'line-dasharray': [3, 3],
        },
        layout: { visibility: 'none' },
      });
    }
    if (!map.getLayer(this.LABEL_LAYER)) {
      map.addLayer({
        id: this.LABEL_LAYER,
        type: 'symbol',
        source: this.SOURCE_ID,
        layout: {
          'text-field': ['get', 'displayName'],
          'text-size': 12,
          'text-anchor': 'center',
          'symbol-placement': 'point',
          'visibility': 'none',
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#0a0e1a',
          'text-halo-width': 1.6,
        },
      });
    }

    // Restore visibility across style switches.
    const vis = this.visible ? 'visible' : 'none';
    [this.FILL_LAYER, this.OUTLINE_LAYER, this.LABEL_LAYER].forEach(id =>
      map.setLayoutProperty(id, 'visibility', vis));

    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), this.POLL_MS);
  }

  show(): void {
    this.visible = true;
    if (!this.map) return;
    [this.FILL_LAYER, this.OUTLINE_LAYER, this.LABEL_LAYER].forEach(id =>
      this.map!.setLayoutProperty(id, 'visibility', 'visible'));
    this.refresh();   // immediate first paint instead of waiting for the next poll
  }
  hide(): void {
    this.visible = false;
    if (!this.map) return;
    [this.FILL_LAYER, this.OUTLINE_LAYER, this.LABEL_LAYER].forEach(id =>
      this.map!.setLayoutProperty(id, 'visibility', 'none'));
  }

  /** Snapshot of the most recent zone counts — handy for a dashboard table. */
  zones(): ZoneStatus[] { return this.cached; }

  // ── Private ─────────────────────────────────────────────────────────────────

  private refresh(): void {
    if (!this.map) return;
    if (!this.visible) return;       // skip while overlay is hidden
    this.http.get<ZoneStatus[]>(`${environment.backendUrl}/api/simulation/zones`)
      .subscribe({
        next: zones => {
          this.cached = zones ?? [];
          const src = this.map?.getSource(this.SOURCE_ID) as { setData?: (d: any) => void } | undefined;
          src?.setData?.(this.toGeoJson(this.cached));
        },
        error: () => {},
      });
  }

  private toGeoJson(zones: ZoneStatus[]): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: zones.map(z => {
        // GeoJSON polygon outer rings must be explicitly closed.
        const ring: [number, number][] = z.polygon?.length
          ? [...z.polygon, z.polygon[0]]
          : [];
        return {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [ring],
          } as GeoJSON.Geometry,
          properties: {
            id:             z.id,
            name:           z.name,
            color:          z.color,
            vehiclesInside: z.vehiclesInside,
            // What the label layer actually renders: "Zone Name (147)".
            displayName:    `${z.name} (${z.vehiclesInside})`,
          },
        };
      }),
    };
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }
}
