/**
 * Frontend environment configuration.
 *
 * To use a custom vector tile style (required for 3D buildings):
 *   - Set VECTOR_STYLE_URL to a MapLibre style JSON URL.
 *   - Example free options:
 *       OpenFreeMap dark:  'https://tiles.openfreemap.org/styles/dark'
 *       OpenFreeMap light: 'https://tiles.openfreemap.org/styles/positron'
 *   - For a local tile server, see CUSTOM_OSM_MAP.md.
 *
 * Leave VECTOR_STYLE_URL empty ('') to use the default dark raster tiles (inverted OSM).
 */
export const environment = {
  production: false,
  backendUrl: 'http://localhost:8080',

  /**
   * Optional: URL to a MapLibre-compatible vector tile style JSON.
   * Leave empty to use the built-in dark raster style.
   * Required for 3D building extrusion.
   */
  VECTOR_STYLE_URL: 'https://tiles.openfreemap.org/styles/dark',

  /**
   * Default map center: La Rochelle — matches the backend's startup OSM file
   * (graph-source: local-file). Importing a different .osm via the Map Import
   * panel recenters automatically via fitBounds().
   */
  MAP_CENTER: [-1.10, 46.16] as [number, number],
  MAP_ZOOM: 12,

  /** Default pitch (°) for a subtle 3D depth feel even in raster mode. */
  MAP_DEFAULT_PITCH: 25,
};
