import { TestBed } from '@angular/core/testing';
import { VehicleUpdate } from './models/vehicle.model';
import { SelectionService } from './selection.service';

describe('SelectionService', () => {
  let service: SelectionService;
  const car: VehicleUpdate = { id: 'c1', lat: 46.1, lon: -1.1, speed: 40, direction: 90, type: 'CAR' };

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(SelectionService);
  });

  it('starts with nothing selected and every vehicle type visible', () => {
    expect(service.selectedVehicle()).toBeNull();
    expect([...service.filters().types].sort())
      .toEqual(['BUS', 'CAR', 'EMERGENCY', 'MOTORCYCLE', 'TRUCK']);
  });

  it('selects and clears a vehicle', () => {
    service.select(car);
    expect(service.selectedVehicle()).toBe(car);
    service.select(null);
    expect(service.selectedVehicle()).toBeNull();
  });

  it('toggles a vehicle type off and back on', () => {
    service.toggleType('BUS');
    expect(service.filters().types.has('BUS')).toBeFalse();
    service.toggleType('BUS');
    expect(service.filters().types.has('BUS')).toBeTrue();
  });

  it('never lets the last visible type be switched off', () => {
    for (const t of ['BUS', 'TRUCK', 'MOTORCYCLE', 'EMERGENCY'] as const) service.toggleType(t);
    service.toggleType('CAR');
    expect([...service.filters().types]).toEqual(['CAR']);
  });

  it('does not mutate the previous filter state', () => {
    const before = service.filters();
    service.toggleType('BUS');
    expect(before.types.has('BUS')).toBeTrue();
  });

  it('flips each overlay flag independently', () => {
    expect(service.filters().heatmapEnabled).toBeFalse();
    service.toggleHeatmap();
    service.toggleTrails();
    service.toggleIris();
    const f = service.filters();
    expect(f.heatmapEnabled).toBeTrue();
    expect(f.trailsEnabled).toBeTrue();
    expect(f.irisEnabled).toBeTrue();
    expect(f.congestionEnabled).toBeFalse();
    service.toggleHeatmap();
    expect(service.filters().heatmapEnabled).toBeFalse();
  });
});
