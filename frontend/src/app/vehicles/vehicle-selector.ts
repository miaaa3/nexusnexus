import { Map as MapLibreMap } from 'maplibre-gl';
import { VehicleUpdate } from '../core/models/vehicle.model';

/**
 * CPU-side click hit-tester.
 *
 * Strategy:
 * - On map click, project all nearby vehicles (from SpatialGrid) to pixel space
 * - Find closest one within HIT_RADIUS_PX pixels
 * - O(k) where k = vehicles in nearby cells — typically <100 even with 5000 total
 */
export class VehicleSelector {
  private static readonly HIT_RADIUS_PX = 18;

  /**
   * Find the vehicle closest to the clicked pixel, or null if none within radius.
   * @param clickPx  pixel coords of the click {x, y}
   * @param candidates  vehicles to test (pre-filtered by spatial grid)
   * @param map  MapLibre map for lngLat→pixel projection
   */
  findNearest(
    clickPx: { x: number; y: number },
    candidates: VehicleUpdate[],
    map: MapLibreMap
  ): VehicleUpdate | null {
    const radius2 = VehicleSelector.HIT_RADIUS_PX ** 2;
    let best: VehicleUpdate | null = null;
    let bestDist2 = Infinity;

    for (const v of candidates) {
      const px = map.project([v.lon, v.lat]);
      const dx = px.x - clickPx.x;
      const dy = px.y - clickPx.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < radius2 && d2 < bestDist2) {
        bestDist2 = d2;
        best = v;
      }
    }

    return best;
  }
}
