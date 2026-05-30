import { Injectable } from '@angular/core';
import { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';
import { VehicleUpdate } from '../core/models/vehicle.model';

const SOURCE_ID = 'nexus-heatmap-source';
const LAYER_ID  = 'nexus-heatmap-layer';

/**
 * Manages a MapLibre heatmap layer driven by live vehicle positions.
 *
 * Performance strategy:
 * - Updates at 2Hz (every 500ms) regardless of WS frame rate
 * - Weight = inverse of speed (slow/stopped vehicles = congestion hotspot)
 * - GeoJSON rebuilt in-place; source data replaced (not diffed) — fast for <5k points
 */
@Injectable({ providedIn: 'root' })
export class HeatmapService {

  private map: MapLibreMap | null = null;
  private active = false;
  private lastUpdate = 0;
  private readonly UPDATE_INTERVAL_MS = 500;

  init(map: MapLibreMap): void {
    this.map = map;
  }

  /**
   * Called every WS frame. Internally throttled.
   */
  update(vehicles: VehicleUpdate[]): void {
    if (!this.active || !this.map) return;
    const now = Date.now();
    if (now - this.lastUpdate < this.UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;

    const features = vehicles.map(v => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [v.lon, v.lat] },
      properties: {
        // Heavier weight for slower vehicles (congestion indicator)
        weight: Math.max(0.1, 1 - v.speed / 120)
      }
    }));

    const source = this.map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (source) {
      source.setData({ type: 'FeatureCollection', features });
    }
  }

  show(): void {
    if (!this.map || this.active) return;
    this.active = true;
    this.lastUpdate = 0;

    if (!this.map.getSource(SOURCE_ID)) {
      this.map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
    }

    if (!this.map.getLayer(LAYER_ID)) {
      this.map.addLayer({
        id: LAYER_ID,
        type: 'heatmap',
        source: SOURCE_ID,
        maxzoom: 17,
        paint: {
          // Weight channel from GeoJSON property
          'heatmap-weight': ['get', 'weight'],

          // Intensity scales with zoom
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 14, 1.5],

          // Color ramp: transparent → dark-blue → cyan → yellow → red
          'heatmap-color': [
            'interpolate', ['linear'], ['heatmap-density'],
            0,    'rgba(0,0,0,0)',
            0.15, 'rgba(15,82,186,0.6)',
            0.4,  'rgba(0,210,210,0.7)',
            0.7,  'rgba(255,220,0,0.8)',
            1.0,  'rgba(255,30,30,0.9)'
          ],

          // Radius scales with zoom
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 8, 8, 14, 20],

          // Fade out as zoom increases (vehicles become individually visible)
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.85, 16, 0]
        }
      // Insert below vehicle layer so vehicles render on top
      }, 'nexus-trails');
    }
  }

  hide(): void {
    if (!this.map || !this.active) return;
    this.active = false;
    if (this.map.getLayer(LAYER_ID))  this.map.removeLayer(LAYER_ID);
    if (this.map.getSource(SOURCE_ID)) this.map.removeSource(SOURCE_ID);
  }

  isActive(): boolean { return this.active; }
}

