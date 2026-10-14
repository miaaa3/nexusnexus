import { Injectable, signal } from '@angular/core';
import { environment } from '../../environments/environment';

/**
 * Defines a map style option displayed in the style switcher.
 */
export interface MapStyleOption {
  id: string;
  name: string;
  /** True when this style provides vector tile sources with building data. */
  supportsBuildings: boolean;
  /** MapLibre style JSON URL, or null for the built-in inline raster style. */
  styleUrl: string | null;
}

/**
 * Built-in inline dark raster style (inverted OSM tiles) (no external style JSON needed).
 * Buildings are not available in raster tiles.
 */
const RASTER_STYLE: MapStyleOption = {
  id: 'dark-raster',
  name: 'Dark (OSM)',
  supportsBuildings: false,
  styleUrl: null,
};

/**
 * Vector tile style — uses the URL from environment config.
 * Exposes building data via the OpenMapTiles schema ('building' source-layer).
 * Disabled when VECTOR_STYLE_URL is empty.
 */
const VECTOR_STYLE: MapStyleOption = {
  id: 'vector',
  name: 'Vector (OSM)',
  supportsBuildings: true,
  styleUrl: environment.VECTOR_STYLE_URL || null,
};

/**
 * MapStyleService
 *
 * Tracks which map style is active and exposes the available style list.
 * The actual map.setStyle() call is performed by MapComponent, which reacts
 * to the currentStyle signal.
 *
 * Responsibilities:
 *  - maintain currentStyle signal
 *  - provide the list of available styles (vector option hidden when no URL)
 *  - expose whether buildings are currently supported
 */
@Injectable({ providedIn: 'root' })
export class MapStyleService {

  /** All available styles. Vector option is excluded when not configured. */
  readonly availableStyles: MapStyleOption[] = [
    RASTER_STYLE,
    ...(VECTOR_STYLE.styleUrl ? [VECTOR_STYLE] : []),
  ];

  readonly currentStyle = signal<MapStyleOption>(RASTER_STYLE);

  get supportsBuildings(): boolean {
    return this.currentStyle().supportsBuildings;
  }

  setStyle(styleId: string): void {
    const found = this.availableStyles.find(s => s.id === styleId);
    if (found) this.currentStyle.set(found);
  }

  /** Returns the MapLibre style object/URL for the current style. */
  getMapLibreStyle(style: MapStyleOption): any {
    if (style.styleUrl) return style.styleUrl;
    // Inline dark raster: CARTO's basemaps now need an API key, so we use the
    // standard OSM tiles and invert them on the GPU (brightness min/max
    // swapped + hue rotation) to get the same dark look with no key.
    return {
      version: 8,
      glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
      sources: {
        'osm-dark': {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }
      },
      layers: [{
        id: 'background', type: 'raster', source: 'osm-dark',
        paint: {
          'raster-brightness-min': 0.92,
          'raster-brightness-max': 0.08,
          'raster-saturation': -0.75,
          'raster-hue-rotate': 200,
          'raster-contrast': 0.15,
        }
      }]
    };
  }
}
