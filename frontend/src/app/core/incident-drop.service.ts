import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';
import { MapStateService } from './map-state.service';

/**
 * Wire-format response shape returned by POST /api/simulation/incidents.
 * The backend snaps coordinates (to the nearest vehicle in priority, then to
 * the road grid as fallback) and returns the FINAL on-map coords so the
 * frontend can fly the camera there with no extra round-trip.
 */
export interface IncidentResponse {
  id:          string;
  type:        IncidentType;
  severity:    number;
  lat:         number;
  lon:         number;
  label:       string;
  expiresAtMs: number;
}

/** Incident types — must match {@code IncidentUpdate.type} on the backend. */
export type IncidentType = 'accident' | 'closure' | 'congestion' | 'construction';

/** Body for POST /api/simulation/incidents. */
export interface CreateIncidentRequest {
  type:        IncidentType;
  severity:    1 | 2 | 3;
  lat:         number;
  lon:         number;
  durationMs?: number;
  label?:      string;
}

/**
 * Shared state for the "Drop event" workflow.
 *
 * <p>The dashboard button toggles {@link active}; while it's true, the map
 * component treats the next click as a drop target instead of letting it fall
 * through to vehicle selection. After a successful POST the mode auto-clears,
 * so dropping is always a one-shot — no risk of accidentally spamming.
 *
 * <p>The type / severity selectors on the dashboard write to
 * {@link nextType} and {@link nextSeverity}; the map click reads those when
 * it builds the request body.
 */
@Injectable({ providedIn: 'root' })
export class IncidentDropService {

  private http     = inject(HttpClient);
  private mapState = inject(MapStateService);

  /** When true, the next map click is consumed as a drop. */
  readonly active     = signal<boolean>(false);
  readonly nextType   = signal<IncidentType>('accident');
  readonly nextSeverity = signal<1 | 2 | 3>(2);

  toggleActive(): void {
    this.active.update(v => !v);
  }

  cancel(): void {
    this.active.set(false);
  }

  /**
   * POST a new incident at the user's click location. The backend snaps the
   * point onto the nearest vehicle (preferred — wrecks it and the incident
   * lands on that car's real position) or onto the nearest road as fallback.
   * On success we fly the camera to the FINAL coords returned by the server
   * so the user sees the accident appear, rather than wondering where their
   * click went.
   *
   * Auto-clears {@link active} so the cursor goes back to normal after one
   * drop — no risk of accidentally spamming.
   */
  async drop(lat: number, lon: number): Promise<void> {
    const body: CreateIncidentRequest = {
      type:     this.nextType(),
      severity: this.nextSeverity(),
      lat,
      lon,
    };
    try {
      const resp = await firstValueFrom(
        this.http.post<IncidentResponse>(
          `${environment.backendUrl}/api/simulation/incidents`, body,
        ),
      );
      // Fly to the actual incident position — could differ from the click
      // by up to ~600 m if it snapped to a nearby car.
      if (resp) this.mapState.panTo(resp.lon, resp.lat);
    } catch (e) {
      console.warn('[IncidentDrop] POST failed', e);
    } finally {
      this.active.set(false);
    }
  }
}
