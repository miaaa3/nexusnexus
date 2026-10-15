import { VehicleUpdate } from '../core/models/vehicle.model';
import { SpatialGrid } from './spatial-grid';

const v = (id: string, lat: number, lon: number): VehicleUpdate =>
  ({ id, lat, lon, speed: 30, direction: 0, type: 'CAR' });

describe('SpatialGrid', () => {
  let grid: SpatialGrid;

  beforeEach(() => {
    grid = new SpatialGrid(0.01);
    grid.update([
      v('a', 46.105, -1.105),
      v('b', 46.106, -1.106),   // same cell as a
      v('c', 46.155, -1.155),   // a few cells away
    ]);
  });

  it('counts every vehicle of the last frame', () => {
    expect(grid.totalCount).toBe(3);
  });

  it('returns only vehicles whose cell overlaps the viewport', () => {
    const ids = grid.query(46.10, 46.11, -1.11, -1.10).map(x => x.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('returns nothing for an empty area', () => {
    expect(grid.query(45.0, 45.01, 0.0, 0.01)).toEqual([]);
  });

  it('skips culling when the viewport covers the whole simulation area', () => {
    expect(grid.query(45.0, 47.0, -2.0, 0.0).length).toBe(3);
  });

  it('forgets the previous frame on update', () => {
    grid.update([v('z', 46.2, -1.2)]);
    expect(grid.totalCount).toBe(1);
    expect(grid.query(46.10, 46.11, -1.11, -1.10)).toEqual([]);
  });

  it('handles an empty frame', () => {
    grid.update([]);
    expect(grid.totalCount).toBe(0);
    expect(grid.query(46.0, 46.2, -1.2, -1.0)).toEqual([]);
  });
});
