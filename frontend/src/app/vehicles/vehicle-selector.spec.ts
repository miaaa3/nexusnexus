import { Map as MapLibreMap } from 'maplibre-gl';
import { VehicleUpdate } from '../core/models/vehicle.model';
import { VehicleSelector } from './vehicle-selector';

/** Fake projection: 1 degree = 1000 px, so no real WebGL map is needed. */
const fakeMap = {
  project: ([lon, lat]: [number, number]) => ({ x: lon * 1000, y: lat * 1000 }),
} as unknown as MapLibreMap;

const v = (id: string, lat: number, lon: number): VehicleUpdate =>
  ({ id, lat, lon, speed: 30, direction: 0, type: 'CAR' });

describe('VehicleSelector', () => {
  const selector = new VehicleSelector();

  it('picks the closest vehicle within the hit radius', () => {
    const near = v('near', 0.005, 0.005);      // ~7 px from the click
    const nearer = v('nearer', 0.001, 0.001);  // ~1.4 px
    const hit = selector.findNearest({ x: 0, y: 0 }, [near, nearer], fakeMap);
    expect(hit?.id).toBe('nearer');
  });

  it('returns null when everything is outside 18 px', () => {
    const far = v('far', 0.05, 0.05);          // ~70 px
    expect(selector.findNearest({ x: 0, y: 0 }, [far], fakeMap)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(selector.findNearest({ x: 0, y: 0 }, [], fakeMap)).toBeNull();
  });
});
