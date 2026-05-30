import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { RenderStats }  from './models/render-stats.model';
import { VehicleUpdate } from './models/vehicle.model';
import { MapBounds } from './map-api.service';

/**
 * Thin bridge service so MapComponent and DashboardComponent
 * can share state without a circular import.
 *
 * MapComponent  → writes stats / searchPool / calls panTo
 * DashboardComponent → reads  stats / searchPool / calls panTo
 */
@Injectable({ providedIn: 'root' })
export class MapStateService {

  readonly stats = signal<RenderStats>({
    fps: 0, renderTimeMs: 0, vehicleCount: 0, wsLatencyMs: 0, framesRendered: 0
  });

  readonly searchPool = signal<VehicleUpdate[]>([]);

  /** Emit to pan the map to a coordinate. MapComponent subscribes. */
  readonly panTo$ = new Subject<{ lon: number; lat: number }>();

  /** Emit to fit the map camera to imported OSM bounds. */
  readonly fitBounds$ = new Subject<MapBounds>();

  /** Emit to clear old visual data after a map graph swap. */
  readonly clearVehicles$ = new Subject<void>();

  /** Emit when user presses R to cycle traffic mode. Dashboard handles the HTTP call. */
  readonly cycleTraffic$ = new Subject<void>();

  /** Emit when user presses P to toggle simulation pause. Dashboard handles the HTTP call. */
  readonly togglePause$ = new Subject<void>();

  panTo(lon: number, lat: number): void {
    this.panTo$.next({ lon, lat });
  }

  fitBounds(bounds: MapBounds): void {
    this.fitBounds$.next(bounds);
  }

  clearVehicles(): void {
    this.clearVehicles$.next();
  }
}
