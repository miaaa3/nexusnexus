import { VehicleUpdate } from '../core/models/vehicle.model';

/**
 * Uniform spatial grid for O(1) average-case vehicle lookups.
 *
 * The map area is divided into cells. Each vehicle is placed
 * into the cell covering its position. Querying a viewport rect
 * only visits cells that overlap it — O(k) where k = cells in view,
 * not O(n) over all vehicles.
 *
 * Used for frustum culling: filter out vehicles outside the
 * current map viewport before uploading to the GPU.
 */
export class SpatialGrid {
  private readonly cellSize: number;
  private readonly cells = new Map<number, VehicleUpdate[]>();
  private allVehicles: VehicleUpdate[] = [];

  constructor(cellSize = 0.01) {   // ~1 km cells at Paris latitude
    this.cellSize = cellSize;
  }

  /**
   * Rebuild the grid from a fresh server frame.
   * Allocates new cell arrays only for non-empty cells.
   */
  update(vehicles: VehicleUpdate[]): void {
    this.cells.clear();
    this.allVehicles = vehicles;

    for (const v of vehicles) {
      const key = this.cellKey(v.lat, v.lon);
      let cell = this.cells.get(key);
      if (!cell) {
        cell = [];
        this.cells.set(key, cell);
      }
      cell.push(v);
    }
  }

  /**
   * Return all vehicles within the given bounding box.
   * Falls back to all vehicles if bounds are very large.
   */
  query(minLat: number, maxLat: number, minLon: number, maxLon: number): VehicleUpdate[] {
    const latSpan = maxLat - minLat;
    const lonSpan = maxLon - minLon;

    // If viewport covers most of the simulation area, skip culling
    if (latSpan > 0.2 && lonSpan > 0.3) return this.allVehicles;

    const result: VehicleUpdate[] = [];
    const minRow = Math.floor(minLat / this.cellSize);
    const maxRow = Math.floor(maxLat / this.cellSize);
    const minCol = Math.floor(minLon / this.cellSize);
    const maxCol = Math.floor(maxLon / this.cellSize);

    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const key = row * 100000 + col;
        const cell = this.cells.get(key);
        if (cell) {
          for (const v of cell) result.push(v);
        }
      }
    }
    return result;
  }

  get totalCount(): number { return this.allVehicles.length; }

  private cellKey(lat: number, lon: number): number {
    const row = Math.floor(lat / this.cellSize);
    const col = Math.floor(lon / this.cellSize);
    return row * 100000 + col;
  }
}
