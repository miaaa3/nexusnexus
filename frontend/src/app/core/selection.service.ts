import { Injectable, signal } from '@angular/core';
import { VehicleType, VehicleUpdate } from './models/vehicle.model';

export interface FilterState {
  types: Set<VehicleType>;
  trailsEnabled: boolean;
  heatmapEnabled: boolean;
  congestionEnabled: boolean;
  mode3dEnabled: boolean;
  incidentsEnabled: boolean;
  geofencesEnabled: boolean;
  irisEnabled: boolean;
}

/**
 * Shared app state: selected vehicle + active overlay filters.
 */
@Injectable({ providedIn: 'root' })
export class SelectionService {

  readonly selectedVehicle = signal<VehicleUpdate | null>(null);

  readonly filters = signal<FilterState>({
    types: new Set(['CAR', 'BUS', 'TRUCK', 'MOTORCYCLE', 'EMERGENCY']),
    trailsEnabled: false,
    heatmapEnabled: false,
    congestionEnabled: false,
    mode3dEnabled: false,
    incidentsEnabled: false,
    geofencesEnabled: false,
    irisEnabled: false,
  });

  select(vehicle: VehicleUpdate | null): void {
    this.selectedVehicle.set(vehicle);
  }

  toggleType(type: VehicleType): void {
    this.filters.update(f => {
      const next = new Set(f.types);
      next.has(type) ? next.delete(type) : next.add(type);
      if (next.size === 0) return f;
      return { ...f, types: next };
    });
  }

  toggleTrails():     void { this.filters.update(f => ({ ...f, trailsEnabled:     !f.trailsEnabled })); }
  toggleHeatmap():    void { this.filters.update(f => ({ ...f, heatmapEnabled:    !f.heatmapEnabled })); }
  toggleCongestion(): void { this.filters.update(f => ({ ...f, congestionEnabled: !f.congestionEnabled })); }
  toggle3dMode():     void { this.filters.update(f => ({ ...f, mode3dEnabled:     !f.mode3dEnabled })); }
  toggleIncidents():  void { this.filters.update(f => ({ ...f, incidentsEnabled:  !f.incidentsEnabled })); }
  toggleGeofences():  void { this.filters.update(f => ({ ...f, geofencesEnabled:  !f.geofencesEnabled })); }
  toggleIris():       void { this.filters.update(f => ({ ...f, irisEnabled:       !f.irisEnabled })); }
}
