import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../environments/environment';

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

  private http = inject(HttpClient);

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
   * POST a new incident. Called by the map component after a drop click.
   * Auto-clears {@link active} on success so the cursor goes back to normal.
   */
  async drop(lat: number, lon: number): Promise<void> {
    const body: CreateIncidentRequest = {
      type:     this.nextType(),
      severity: this.nextSeverity(),
      lat,
      lon,
    };
    try {
      await firstValueFrom(
        this.http.post(`${environment.backendUrl}/api/simulation/incidents`, body),
      );
    } catch (e) {
      console.warn('[IncidentDrop] POST failed', e);
    } finally {
      this.active.set(false);
    }
  }
}
