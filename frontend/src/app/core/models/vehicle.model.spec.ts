import { VEHICLE_COLORS, VEHICLE_SIZES, VehicleType, WRECK_SIZE } from './vehicle.model';

describe('vehicle model constants', () => {
  const types: VehicleType[] = ['CAR', 'BUS', 'TRUCK', 'MOTORCYCLE', 'EMERGENCY'];

  it('defines a colour and a size for every vehicle type', () => {
    for (const t of types) {
      expect(VEHICLE_COLORS[t]).toBeDefined();
      expect(VEHICLE_SIZES[t]).toBeGreaterThan(0);
    }
  });

  it('keeps colour channels within 0..1 for WebGL', () => {
    for (const t of types) {
      for (const c of VEHICLE_COLORS[t]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('draws wrecks bigger than any normal vehicle', () => {
    for (const t of types) expect(WRECK_SIZE).toBeGreaterThan(VEHICLE_SIZES[t]);
  });
});
